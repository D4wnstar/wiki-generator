import { Notice } from "obsidian"
import { Root } from "hast"
import { partition } from "src/utils"
import { Processor } from "unified"
import { Detail, SidebarImage, ContentChunk } from "../database/types"
import {
	secretBlockRegex,
	secretBlockRegexNoGroups,
	transclusionRegex,
	transclusionRegexNoGroups,
} from "./regexes"

/**
 * Parse Markdown text, removing all\* special :::blocks::: and
 * returning their content. Also takes care of converting each block's
 * Markdown into HTML.
 *
 *
 * \*This function ignores :::secret::: blocks.
 * Use the `chunkMd` function to split the page by those.
 * @param md The markdown text to transform
 * @param filename The name of the file that's being processed
 * @param processor A unified processor to convert Markdown into HTML
 * @param imageNameToId A map that links image filenames to their base64 representation
 * @returns The modified text, alongside all other additional data from custom blocks
 */
export async function replaceCustomBlocks(
	md: string,
	filename: string,
	processor: Processor<Root, Root, Root, Root, string>,
	imageNameToId: Map<string, number>
) {
	// Remove :::hidden::: blocks
	md = md.replace(/^:::hidden\n.*?\n:::/gms, "")

	// Find, parse and remove the first :::details::: block
	// Any other :::details::: block will be ignored
	// Both keys and values will be converted into HMTL
	let details: Detail[] = []
	const detailsRegex = /^:::details\n(.*?)\n:::/ms
	const detailsMatch = md.match(detailsRegex)
	if (detailsMatch) {
		details = await parseDetailsBlock(detailsMatch[1], processor, filename)
		if (details.length === 0) {
			new Notice(`Improperly formatted :::details::: in ${filename}`)
			console.warn(`Improperly formatted :::details::: in ${filename}`)
		}
		md = md.replace(detailsRegex, "")
	}

	// Find, parse and remove all :::image::: blocks
	// Image links are replaced with their base64 representation and
	// embedded into HMTL as-is. Captions are converted into HTML
	const sidebarImages: SidebarImage[] = []
	const imageRegex = /^:::image(\(fullres\))?\n(.*?)\n:::/gms
	const imageMatch = Array.from(md.matchAll(imageRegex))
	for (const i in imageMatch) {
		const index = parseInt(i)
		const match = imageMatch[index]
		const img = await parseImageBlock(
			match[2],
			index + 1,
			processor,
			imageNameToId,
			filename
		)
		if (img) sidebarImages.push(img)
		md = md.replace(match[0], "")
	}

	return { md, details, sidebarImages }
}

/**
 * Parse the contents of a :::details::: block.
 * @param contents The contents of a :::details::: block
 * @param processor A unified processor to convert Markdown into HTML
 * @param filename The filename of the file the block comes from, for user-friendly warnings
 * @returns A list Detail objects, one for each line in the block
 */
async function parseDetailsBlock(
	contents: string,
	processor: Processor<Root, Root, Root, Root, string>,
	filename: string
): Promise<Detail[]> {
	const detailsList: Detail[] = []
	const details = contents.split("\n").filter((line) => line !== "")

	for (const i in details) {
		const index = parseInt(i)
		const detail = details[i]

		// Ignore empty lines
		if (detail === "") continue

		// Split lines into key-value paris
		const split = detail.split(/:\s*/)
		if (split.length === 0) {
			// Ignore broken formatting and emit a warning
			new Notice(`Improperly formatted :::details::: in ${filename}`)
			console.warn(`Improperly formatted :::details::: in ${filename}`)
			return [{ order: 1, key: "", value: "" }]
		}
		if (split.length === 1) {
			// Key-only details are valid
			const key = (await processor.process(split[0])).toString()
			detailsList.push({
				order: index + 1,
				key,
				value: null,
			})
		} else {
			// Both key and value. Make sure to handle excess splits due to additional
			// colons in the value, which are allowed
			const key = (await processor.process(split[0])).toString()
			const preValue = split.splice(1).reduce((a, b) => a + ": " + b)
			const value = (await processor.process(preValue)).toString()
			detailsList.push({
				order: index + 1,
				key,
				value,
			})
		}
	}

	return detailsList
}

/**
 * Parse the contents of an :::image::: block.
 * @param contents The contents of an :::image::: block
 * @param order The ordering of the block in the page, compared to other :::image::: blocks
 * @param processor A unified processor to convert the caption into HTML
 * @param imageNameToId A Map linking image filenames into their id in the database
 * @param filename The filename of the file the block comes from, for user-friendly warnings
 * @returns A SidebarImage object encoding the block's contents.
 * May be undefined if the formatting is wrong.
 */
async function parseImageBlock(
	contents: string,
	order: number,
	processor: Processor<Root, Root, Root, Root, string>,
	imageNameToId: Map<string, number>,
	filename: string
): Promise<SidebarImage | undefined> {
	// An :::image::: block should be made up of 1 or 2 lines
	// The first is mandatory and is the wikilink to the image
	// The second is optional and is the caption
	// Any other line will be considered a part of the caption

	const lines = contents.split("\n").filter((line) => line !== "")
	if (lines.length === 0) {
		// Ignore broken formatting and emit a warning
		console.warn(`Error parsing :::image::: block in ${filename}.`)
		new Notice(`Error parsing :::image::: block in ${filename}.`)
		return undefined
	}

	// Grab the image filename from the wikilink
	const wikilink = lines[0].match(/!\[\[(.*?)(\|.*)?\]\]/)
	if (!wikilink) {
		console.warn(
			`Failed to find image filename in :::image::: block in ${filename}.`
		)
		new Notice(
			`Failed to find image filename in :::image::: block in ${filename}.`
		)
		return undefined
	}
	const imageFile = wikilink[1]

	// Then the caption, if present
	let caption: string | null
	if (lines.length > 1) {
		caption = lines.splice(1).join("\n")
		caption = (await processor.process(caption)).toString()
	} else {
		caption = null
	}

	// Grab the base64 representation for the current image and skip the block if it isn't found
	const image_id = imageNameToId.get(imageFile)
	if (!image_id) {
		return undefined
	}

	return {
		order,
		image_name: imageFile,
		image_id,
		caption,
	}
}

/**
 * Split Markdown text into chunks with different user permission.
 * The text is currently split by :::secret::: blocks and each is given
 * the permission determined by the argument of the block.
 * @param text The text to split
 * @param imageNameToId A mapping between image filenames and their database row id
 * @returns An array ContentChunks
 */
export function chunkMd(
	text: string,
	imageNameToId: Map<string, number>
): ContentChunk[] {
	// First, partition by secrets while replacing each block with its contents
	const splits = partition(text, secretBlockRegexNoGroups)

	// Get a list of the users mentioned in the blocks
	const secretUsers = [...text.matchAll(secretBlockRegex)].map(
		(match) => match[1]
	)

	const tempChunks: ContentChunk[] = []
	for (const [idx, split] of splits.entries()) {
		// Only odd splits are secret: "pub sec pub" -> ["pub ", "sec", " pub"]
		// This still applies if there is a secret block at the start or end
		// (pub would be an empty string)
		let allowed_users: string | null
		let text: string
		if (idx % 2 === 1) {
			const usersIdx = Math.floor(idx / 2)
			// Guarantee that users are split by semicolon and that there is no extra whitespace
			allowed_users = secretUsers[usersIdx]
				.split(",")
				.map((s) => s.trim())
				.join(";")
			// Also replace each block with its own contents
			text = split.replace(secretBlockRegex, "$2")
		} else {
			allowed_users = null
			text = split
		}

		tempChunks.push({
			chunk_id: idx + 1,
			text,
			allowed_users,
			image_id: null,
		})
	}

	// Do the same for every transclusion, in every chunk
	const tempChunks2: ContentChunk[] = []
	for (const chunk of tempChunks) {
		const linkNames = [...chunk.text.matchAll(transclusionRegex)].map(
			(match) => match[1]
		)
		const splits = partition(chunk.text, transclusionRegexNoGroups)

		const currOffset = tempChunks2.length
		for (const [idx, split] of splits.entries()) {
			let image_id: number | null
			if (idx % 2 === 1) {
				const imageNameIdx = Math.floor(idx / 2)
				const linkName = linkNames[imageNameIdx]
				// This nullish coalescing also takes care of non-image file formats and text transclusions
				image_id = imageNameToId.get(linkName) ?? null
			} else {
				image_id = null
			}

			tempChunks2.push({
				chunk_id: idx + currOffset,
				text: split,
				// Inherit allowed users from the current chunk
				allowed_users: chunk.allowed_users,
				image_id,
			})
		}
	}

	return tempChunks2
}
