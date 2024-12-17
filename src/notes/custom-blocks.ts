import { Notice } from "obsidian"
import { Root } from "hast"
import { partition } from "src/utils"
import { Processor } from "unified"
import { Detail, SidebarImage, ContentChunk } from "../database/types"

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
 * @param imageBase64 A map that links image filenames to their base64 representation
 * @returns The modified text, alongside all other additional data from custom blocks
 */
export async function replaceCustomBlocks(
	md: string,
	filename: string,
	processor: Processor<Root, Root, Root, Root, string>,
	imageBase64: Map<string, string>
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
			imageBase64,
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
				value: undefined,
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
 * @param imageBase64 A Map linking image filenames into their base64 representation
 * @param filename The filename of the file the block comes from, for user-friendly warnings
 * @returns A SidebarImage object encoding the block's contents.
 * May be undefined if the formatting is wrong or the base64 representation was not found
 */
async function parseImageBlock(
	contents: string,
	order: number,
	processor: Processor<Root, Root, Root, Root, string>,
	imageBase64: Map<string, string>,
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
	let caption: string | undefined
	if (lines.length > 1) {
		caption = lines.splice(1).join("\n")
		caption = (await processor.process(caption)).toString()
	}

	// Grab the base64 representation for the current image and skip the block if it isn't found
	const base64 = imageBase64.get(imageFile)
	if (!base64) {
		return undefined
	}

	return {
		order,
		image_name: imageFile,
		base64,
		caption,
	}
}

/**
 * Split Markdown text into chunks with different user permission.
 * The text is currently split by :::secret::: blocks and each is given
 * the permission determined by the argument of the block. Each block's permissions
 * are merged with the global permissions of the page.
 * @param text The text to split
 * @param allowedUsers A list of allowed users for the current page
 * @returns An array ContentChunks
 */
export function chunkMd(text: string, allowedUsers: string[]): ContentChunk[] {
	const secretChunks = [
		...text.matchAll(/^:::secret\s*\((.*?)\)\n(.*?)\n:::/gms),
	]

	// If there are no :::secret::: blocks, returns the page as-is
	if (secretChunks.length === 0) {
		return [{ chunk_id: 1, text, allowed_users: allowedUsers }]
	}

	// Replace each block with its content
	text = text.replace(/^:::secret\s*\((.*?)\)\n(.*?)\n:::/gms, "$2")

	let currChunkId = 1
	const chunks: ContentChunk[] = []

	for (const match of secretChunks) {
		let currText: string
		const users = match[1].split(",").map((s) => s.trim())

		// Merge chunk users with global users whilst avoiding duplication
		allowedUsers.forEach((user) => {
			if (!users.includes(user)) users.push(user)
		})

		if (chunks.length > 0) {
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			currText = chunks.pop()!.text
			currChunkId -= 1
		} else {
			currText = text
		}

		const parts = partition(currText, match[2])
		for (const i in parts) {
			chunks.push({
				chunk_id: currChunkId,
				text: parts[i],
				allowed_users: parseInt(i) % 2 !== 0 ? users : allowedUsers,
				// The way `partition` works puts all secret chunks on odd indexes
			})
			currChunkId += 1
		}
	}

	return chunks
}
