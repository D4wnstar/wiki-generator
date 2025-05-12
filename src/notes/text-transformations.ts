import { TFile, Vault } from "obsidian"
import { ensureUniqueSlug, replaceAllAsync, slugPath } from "src/utils"
import { Processor, unified } from "unified"
import { handleCustomSyntax } from "./custom-blocks"
import {
	ContentChunk,
	Detail,
	Frontmatter,
	Note,
	Pages,
	SidebarImage,
} from "../database/types"

import remarkParse from "remark-parse"
import remarkGfm from "remark-gfm"
import remarkFrontmatter from "remark-frontmatter"
import remarkRehype from "remark-rehype"
import remarkMath from "remark-math"
import remarkFrontmatterExport from "../unified/remark-frontmatter-export"

import rehypeStylist from "../unified/rehype-stylist"
import rehypeParse from "rehype-parse"
import rehypeCallouts from "rehype-callouts"
import rehypePrism from "rehype-prism-plus"
import rehypeKatex from "rehype-katex"
import rehypeMermaid from "rehype-mermaid"
import rehypeSlug from "rehype-slug"
import rehypeStringify from "rehype-stringify"

/**
 * Convert Markdown files into rich data structures encoding their contents.
 * @param files A list of Markdown files
 * @param processor A unified processor to convert Markdown into HTML
 * @param frontmatterProcessor A unified process to extract markdown frontmatter
 * @param imageNameToPath A Map linking image filenames with their base64 representation
 * @param vault A reference to the vault
 * @returns A Pages object containing all converted data and a Map linking lowercase
 * page titles with their full filepath slugs.
 */
export async function makePagesFromFiles(
	files: { file: TFile; hash: string }[],
	imageNameToPath: Map<string, string>,
	vault: Vault
): Promise<{ pages: Pages; titleToPath: Map<string, string> }> {
	const lastUpdated = Math.floor(Date.now() / 1000)
	const pages: Pages = new Map()
	const titleToPath: Map<string, string> = new Map()
	const noteNameToPath: Map<string, { path: string; isExcalidraw: boolean }> =
		new Map()

	for (const { file } of files) {
		const content = await vault.cachedRead(file)
		const isExcalidraw = content.includes("excalidraw-plugin:")
		noteNameToPath.set(file.basename, { path: file.path, isExcalidraw })
	}

	// Initialize unified processors to handle syntax conversion and frontmatter export
	const processor = unified()
		.use(remarkParse) // Parse markdown into a syntax tree
		.use(remarkGfm, { singleTilde: false }) // Parse Github-flavored markdown
		.use(remarkMath) // Parse $inline$ and $$display$$ math blocks
		.use(remarkFrontmatter) // Expose frontmatter in the syntax tree
		.use(remarkRehype, { allowDangerousHtml: true }) // Convert to an HTML syntax tree
		.use(rehypeKatex, { trust: true }) // Render LaTeX math with KaTeX
		.use(rehypeSlug) // Add ids to headers
		.use(rehypeCallouts) // Handle Obsidian-style callouts
		.use(rehypeStylist) // Add classes to tags that are unstyled in Tailwind
		.use(rehypePrism, { defaultLanguage: "markdown", ignoreMissing: true }) // Highlight code blocks
		.use(rehypeMermaid, { strategy: "img-svg", dark: true }) // Render Mermaid diagrams
		.use(rehypeStringify, { allowDangerousHtml: true }) // Compile syntax tree into an HTML string

	const latexProcessor = unified()
		.use(remarkParse)
		.use(remarkMath)
		.use(remarkRehype, { allowDangerousHtml: true })
		.use(rehypeKatex, { trust: true })
		.use(rehypeStringify, { allowDangerousHtml: true })

	const frontmatterProcessor = unified()
		.use(remarkFrontmatter)
		.use(remarkFrontmatterExport) // Export the frontmatter into an array
		.use(rehypeParse)
		.use(rehypeStringify)

	// Keep track of previous slugs to avoid collisions
	// This is done manually despite using github-slugger because slugger turns
	// '/' into '-' and breaks paths, so it is instead ran on each path element
	// and the full path is reconstructed and tracked manually
	const previousSlugs: Set<string> = new Set()

	for (const { file, hash } of files) {
		const title = file.basename
		const path = file.path
		const slug = ensureUniqueSlug(slugPath(file.path), previousSlugs)
		previousSlugs.add(slug)

		let content = await vault.cachedRead(file)

		// Grab the frontmatter first because we need some properties
		const fmVfile = await frontmatterProcessor.process(content)
		const frontmatter = fmVfile.data.matter as Frontmatter

		// Skip pages that shouldn't be published (wiki-publish is either false or undefined)
		if (!frontmatter["wiki-publish"]) continue

		// Parse and replace custom :::blocks::: and other non-standard syntax
		// Codeblocks are removed and added back later to keep them unmodified
		content = await processDisplayLatex(content, latexProcessor)
		const { md, inlineCode, codeBlocks } = removeCodeblocks(content)
		const { md: md2, footnotes } = await removeFootnotes(md, processor)
		const { wChunks, details, sidebarImages } = await handleCustomSyntax(
			md2,
			file.name,
			processor,
			imageNameToPath,
			noteNameToPath
		)
		let chunks = addFootnotesBack(wChunks.chunks, footnotes)
		chunks = addCodeblocksBack(chunks, inlineCode, codeBlocks)

		// Convert the markdown of each chunk separately
		for (const chunk of chunks) {
			if (!chunk.text) continue
			chunk.text = String(await processor.process(chunk.text))
		}

		// Save the current title/slug pair for later use
		titleToPath.set(title.toLowerCase(), slug)

		// Get aliases as search terms
		const alt_title = frontmatter["wiki-title"] ?? null
		const aliases = frontmatter["aliases"]?.join("; ") as string | undefined
		let search_terms = title
		search_terms += alt_title ? `; ${alt_title}` : ""
		search_terms += aliases ? `; ${aliases}` : ""

		// A page can be prerendered if it does not depend on user permission
		const allowed_users =
			frontmatter["wiki-allowed-users"]?.join("; ") ?? null
		const requiresAuth =
			allowed_users !== null ||
			chunks.some((chunk) => chunk.allowed_users !== null)

		const note: Note = {
			title,
			alt_title,
			search_terms,
			path,
			slug: slug,
			frontpage: frontmatter["wiki-home"] ?? 0,
			lead: "", // Currently unused, needed for popups once they are reimplemented
			allowed_users,
			hash,
			last_updated: lastUpdated,
			can_prerender: Number(!requiresAuth),
		}
		pages.set(path, { note, chunks, details, sidebarImages })
	}

	return { pages, titleToPath }
}

/**
 * Replace inline code and codeblocks with plain text identifiers (<|inlinecode_i|> and
 * <|codeblock_i|> where i is the order of appearance of the codeblock (starting from 1).
 * Intended to be * coupled with `addCodeblocksBack`, mostly to prevent codeblocks from
 * being formatted.
 * @param text The Markdown text to transform
 * @returns The modified text and a list of Markdown codeblocks
 */
export function removeCodeblocks(text: string): {
	md: string
	inlineCode: Map<number, string>
	codeBlocks: Map<number, string>
} {
	// Remove codeblocks from the markdown as anything inside of them should be kept as is
	// Instead, add a generic marker to know where the codeblocks were and add them back later
	const codeBlockRegex = /^```(\w*)\n(.*?)\n```/gms
	const inlineCodeRegex = /(?<=[^`])`([^`\n]+?)`(?!`)/g

	const codeBlocks: Map<number, string> = new Map()
	const inlineCode: Map<number, string> = new Map()

	let counter = 0
	text = text.replace(codeBlockRegex, (block, lang) => {
		// Ignore TikZ! These are rendered into SVG separately when chunking
		if (lang === "tikz") return block
		counter += 1
		codeBlocks.set(counter, block)
		return `<|codeblock_${counter}|>`
	})

	counter = 0
	text = text.replace(inlineCodeRegex, (block) => {
		counter += 1
		inlineCode.set(counter, block)
		return `<|inlinecode_${counter}|>`
	})

	return { md: text, inlineCode, codeBlocks }
}

/**
 * Add codeblocks and inline code removed by `removeCodeblocks`.
 * @param text The markdown to transform
 * @param codeBlocks A string array of codeblocks
 * @returns The transformed markdown, with all codeblocks put back in place
 */
export function addCodeblocksBack(
	chunks: ContentChunk[],
	inlineCode: Map<number, string>,
	codeBlocks: Map<number, string>
): ContentChunk[] {
	return chunks.map((chunk) => {
		const text = chunk.text
			.replace(
				/<\|inlinecode_(\d+)\|>/g,
				(_match, blockId) => inlineCode.get(parseInt(blockId)) ?? ""
			)
			.replace(
				/<\|codeblock_(\d+)\|>/g,
				(_match, blockId) => codeBlocks.get(parseInt(blockId)) ?? ""
			)
		return { ...chunk, text }
	})
}

/**
 * LaTeX display blocks are kinda broken with the builtin remark/rehype pipeline if they
 * are not on a clean line. They break if they are on a line with existing formatting, such
 * as a list, a blockquote or a callout. As a workaround, thi function extracts display math
 * blocks individually and process them in isolation. The HTML is then intended to be passed
 * as-is through the main processor.
 *
 * It also updates environments that lead to automatic equation numbering in normal LaTeX, like
 * `align`, and turns them in their respective non-numbering version, like `align*`, to match
 * Obsidian behavior.
 *
 * @param md The text to process
 * @param latexProcessor A processor to convert math blocks into HTML
 * @returns The processed text
 */
async function processDisplayLatex(
	md: string,
	latexProcessor: Processor<any, any, any, any, any>
) {
	md = md.replaceAll(
		/\\(begin|end){(align|equation|gather|multline|eqnarray)}/g,
		"\\$1{$2*}"
	)
	return await replaceAllAsync(
		md,
		/^\s*([>-])\s*\$\$(.*?)\$\$/gms,
		async (_match, before, inner) => {
			inner = inner.replaceAll(/^\s*[>-]\s*/gm, "")
			return (
				before +
				String(await latexProcessor.process(`\n$$\n${inner}\n$$\n\n`))
			)
		}
	)
}

/**
 * Remove footnote definitions and encode references to those footnotes to avoid them being
 * processed by the main loop. This is because automatic footnote processing is broken when
 * done chunk-by-chunk since they require referencing all the way across the file. Meant to
 * be paired with `addFootnotesBack`.
 *
 * @param md The text to parse
 * @param processor General purpose processor to convert md to HTML
 * @returns The text without the footnotes and encoded references
 */
async function removeFootnotes(
	md: string,
	processor: Processor<any, any, any, any, any>
) {
	const footnotes: Map<string, string> = new Map()
	for (const match of md.matchAll(/^\[\^(.*?)\]:\s*(.*)/gm)) {
		const id = encodeURIComponent(match[1])
		const text = match[2] + ` <a class="anchor" href="#ref_${id}">↩</a>`
		footnotes.set(match[1], String(await processor.process(text)))
	}

	md = md.replaceAll(/^\[\^.*?\]:.*/gm, "")
	md = md.replaceAll(/\[\^(.*?)\]/g, "<|footnote_$1|>")
	return { md, footnotes }
}

/**
 * Add the footnotes removed by `removeFootnotes`.
 * @param chunks The chunks to process
 * @param footnotes The Map of footnotes created by `removeFootnotes`
 * @returns The processed chunks
 */
function addFootnotesBack(
	chunks: ContentChunk[],
	footnotes: Map<string, string>
) {
	for (const [idx, chunk] of chunks.entries()) {
		chunk.text = chunk.text.replaceAll(/<\|footnote_(.*?)\|>/g, (_m, i) => {
			const id = encodeURIComponent(i)
			return `<sup id="ref_${id}"><a class="anchor" href="#footnote_${id}">[${i}]</a></sup>`
		})

		if (idx === chunks.length - 1 && footnotes.size > 0) {
			const footnoteText = footnotes.entries().reduce((t, [i, f]) => {
				const id = encodeURIComponent(i)
				return (t += `<div class="flex" id="footnote_${id}"><span style="opacity: 0.5; margin-right: 4px;">${i}.</span>${f}</div>`)
			}, "")

			chunk.text +=
				'<hr class="hr" /><section class="space-y-2">' +
				footnoteText +
				"</section>"
		}
	}

	return chunks
}

/**
 * Unwrap wikilinks by removing the brackets around them, replacing them with the linked
 * note's name or its alias, if present.
 * @param text The text to modify
 * @param removeReferences Whether to delete references instead of unwrapping them
 * @param removeTransclusions Whether to delete transclusions instead of unwrapping them
 * @returns The modified text
 * @example '[[Page name]]' -> 'Page name'
 * @example '[[Page name#Header]]' -> 'Page name'
 * @example '[[Page name#Header|Alias]]' -> 'Alias'
 */
export function unwrapWikilinks(
	text: string,
	removeReferences = false,
	removeTransclusions = false
): string {
	const transclusionRegex = /!\[\[(.*?)(#\^?.*?)?(\|.*?)?\]\]/g
	const referenceRegex = /\[\[(.*?)(#\^?.*?)?(\|.*?)?\]\]/g

	console.log("Replacing transclusions")
	text = text.replaceAll(transclusionRegex, (_match, groups) => {
		if (removeTransclusions) return ""
		if (groups[3]) return groups[3]
		return groups[1]
	})

	console.log("Replacing references")
	text = text.replace(referenceRegex, (_match, groups) => {
		if (removeReferences) return ""
		if (groups[3]) return groups[3]
		return groups[1]
	})

	return text
}

export async function convertWikilinks(
	pages: Pages,
	processor: Processor<any, any, any, any, any>
) {
	const newPages: Pages = new Map()

	// Create a new version of each page where all text has been run
	// through wikilink conversion
	for (const [id, page] of pages.entries()) {
		// Note objects have no text

		// Process each ContentChunk
		const newChunks: ContentChunk[] = []
		for (const chunk of page.chunks) {
			const newText = await processor
				.process(chunk.text)
				.then((vfile) => String(vfile))

			newChunks.push({ ...chunk, text: newText })
		}

		// Process all Details. Only values need to be converted
		const newDetails: Detail[] = []
		for (const detail of page.details) {
			let newValue: string | null
			if (detail.value) {
				newValue = await processor
					.process(detail.value)
					.then((vfile) => String(vfile))
			} else {
				newValue = null
			}

			newDetails.push({ ...detail, value: newValue })
		}

		// Process all sidebar image captions
		const newSidebarImages: SidebarImage[] = []
		for (const img of page.sidebarImages) {
			let newCaption: string | null
			if (img.caption) {
				newCaption = await processor
					.process(img.caption)
					.then((vfile) => String(vfile))
			} else {
				newCaption = null
			}

			newSidebarImages.push({ ...img, caption: newCaption })
		}

		newPages.set(id, {
			note: page.note,
			chunks: newChunks,
			details: newDetails,
			sidebarImages: newSidebarImages,
		})
	}

	return newPages
}
