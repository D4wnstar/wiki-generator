import { TFile, Vault } from "obsidian"
import { Root } from "remark-parse/lib"
import { slugPath } from "src/utils"
import { Processor } from "unified"
import { replaceCustomBlocks, chunkMd } from "./custom-blocks"
import { Frontmatter, Pages } from "../database/types"

/**
 * Convert Markdown files into rich data structures encoding their contents.
 * @param files A list of Markdown files
 * @param processor A unified processor to convert Markdown into HTML
 * @param frontmatterProcessor A unified process to extract markdown frontmatter
 * @param imageBase64 A Map linking image filenames with their base64 representation
 * @param vault A reference to the vault
 * @returns A Pages object containing all converted data and a Map linking lowercase
 * page titles with their full filepath slugs.
 */
export async function makePagesFromFiles(
	files: TFile[],
	processor: Processor<Root, Root, Root, Root, string>,
	frontmatterProcessor: Processor<Root, undefined, undefined, Root, string>,
	imageBase64: Map<string, string>,
	vault: Vault
): Promise<{ pages: Pages; titleToPath: Map<string, string> }> {
	const pages: Pages = new Map()
	const titleToPath: Map<string, string> = new Map()

	for (const [noteId, file] of files.entries()) {
		const _slug = slugPath(file.path)
		const title = file.name.replace(".md", "")
		const path = file.path.replace(".md", "")
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
		const { md: strippedMd, codeBlocks } = removeCodeblocks(content)
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
			imageBase64
		)
		const md = addCodeblocksBack(strippedMd3, codeBlocks)
			.replace(/^\$\$/gm, "$$$$\n") // remarkMath needs newlines to consider a math block as display
			.replace(/\$\$$/gm, "\n$$$$") // The quadruple $ is because $ is the backreference character in regexes and is escaped as $$, so $$$$ -> $$

		// Split the page into chunks based on permissions
		const chunks = chunkMd(md, frontmatter["wiki-allowed-users"] ?? [])

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
		titleToPath.set(title.toLowerCase(), _slug)

		const note = {
			title,
			alt_title: frontmatter["wiki-title"] ?? null,
			path,
			slug: _slug,
			frontpage: frontmatter["wiki-home"] ?? 0,
			lead,
			allowed_users:
				frontmatter["wiki-allowed-users"]?.join("; ") ?? null,
		}
		pages.set(noteId + 1, { note, chunks, details, sidebarImages })
	}

	return { pages, titleToPath }
}

/**
 * Replace codeblocks with plain text identifiers like <|codeblock_i|> where i
 * is the order of appearance of the codeblock (starting from 1). Intended to be
 * coupled with `addCodeblocksBack`, mostly to prevent codeblocks from being formatted.
 * @param text The Markdown text to transform
 * @returns The modified text and a list of Markdown codeblocks
 */
export function removeCodeblocks(text: string) {
	// Remove codeblocks from the markdown as anything inside of them should be kept as is
	// Instead, add a generic marker to know where the codeblocks were and add them back later
	const codeBlockRegex = /^```(\w*)\n(.*?)\n```/gms

	const codeBlocks: string[] = []
	let counter = 0
	text = text.replace(codeBlockRegex, (block) => {
		counter += 1
		codeBlocks.push(block)
		return `<|codeblock_${counter}|>`
	})

	return { md: text, codeBlocks }
}

/**
 * Add codeblocks removed by `removeCodeblocks` back in the text.
 * Make sure the length of `codeBlocks` is equal to the number of matches in the text.
 * If you got `codeBlocks` from `removeCodeblocks`, this should be guaranteed.
 * @param text The markdown to transform
 * @param codeBlocks A string array of codeblocks
 * @returns The transformed markdown, with all codeblocks put back in place
 */
export function addCodeblocksBack(text: string, codeBlocks: string[]): string {
	text = text.replace(
		/<\|codeblock_(\d+)\|>/g,
		(_match, index) => codeBlocks[index - 1]
	)

	return text
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
