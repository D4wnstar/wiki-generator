import { TFile, Vault } from "obsidian"
import { Root } from "remark-parse/lib"
import { ensureUniqueSlug, slugPath } from "src/utils"
import { Processor } from "unified"
import { replaceCustomBlocks, chunkMd } from "./custom-blocks"
import {
	ContentChunk,
	Detail,
	Frontmatter,
	Note,
	Pages,
	SidebarImage,
} from "../database/types"

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
	processor: Processor<Root, Root, Root, Root, string>,
	frontmatterProcessor: Processor<Root, undefined, undefined, Root, string>,
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

		const content = await vault.read(file)

		// Grab the frontmatter first because we need some properties
		const fmVfile = await frontmatterProcessor.process(content)
		const frontmatter = fmVfile.data.matter as Frontmatter

		// Skip pages that shouldn't be published (wiki-publish is either false or undefined)
		if (!frontmatter["wiki-publish"]) {
			continue
		}

		// Parse and replace custom :::blocks::: and delete Obsidian comments
		// Codeblocks are removed and added back later to keep them unmodified
		const {
			md: strippedMd,
			inlineCode,
			codeBlocks,
		} = removeCodeblocks(content)
		const strippedMd2 = strippedMd.replace(/%%.*?%%/gs, "")
		const {
			md: strippedMd3,
			details,
			sidebarImages,
		} = await replaceCustomBlocks(
			strippedMd2,
			file.name,
			//@ts-ignore
			processor,
			imageNameToPath
		)
		const strippedMd4 = strippedMd3
			.replace(/^\$\$/gm, "$$$$\n") // remarkMath needs newlines to consider a math block as display
			.replace(/\$\$$/gm, "\n$$$$") // The quadruple $ is because $ is the backreference character in regexes and is escaped as $$, so $$$$ -> $$

		// Split the page into chunks based on permissions
		const tempChunks = chunkMd(strippedMd4, noteNameToPath, imageNameToPath)

		const chunks = addCodeblocksBack(tempChunks, inlineCode, codeBlocks)

		// Convert the markdown of each chunk separately
		chunks.forEach(async (chunk) => {
			const vfile = await processor.process(chunk.text)
			chunk.text = String(vfile)
		})

		// Get everything until the first header as the lead
		const leadMatch = chunks[0].text.match(/(.+?)(?=<h\d)/s)
		const lead = leadMatch
			? unwrapWikilinks(leadMatch[1], false, true)
			: chunks[0].text

		// Save the current title/slug pair for later use
		titleToPath.set(title.toLowerCase(), slug)

		const note: Note = {
			title,
			alt_title: frontmatter["wiki-title"] ?? null,
			path,
			slug: slug,
			frontpage: frontmatter["wiki-home"] ?? 0,
			lead,
			allowed_users:
				frontmatter["wiki-allowed-users"]?.join("; ") ?? null,
			hash,
			last_updated: lastUpdated,
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
	text = text.replace(codeBlockRegex, (block) => {
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

	text = text.replaceAll(transclusionRegex, (_match, groups) => {
		if (removeTransclusions) return ""
		if (groups[3]) return groups[3]
		return groups[1]
	})

	text = text.replace(referenceRegex, (_match, groups) => {
		if (removeReferences) return ""
		if (groups[3]) return groups[3]
		return groups[1]
	})

	return text
}

export async function convertWikilinks(
	pages: Pages,
	processor: Processor<Root, undefined, undefined, Root, string>
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

		// Process all Details. Only values need to converted
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
