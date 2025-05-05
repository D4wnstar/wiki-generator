import { Notice } from "obsidian"
import { Root } from "hast"
import { partition } from "src/utils"
import { Processor } from "unified"
import { Detail, SidebarImage, ContentChunk } from "../database/types"
import {
	secretRegex,
	secretRegexNoGroups,
	transclusionRegex,
	transclusionRegexNoGroups,
} from "./regexes"

abstract class Block {
	protected static getRegex(name: string): RegExp {
		return new RegExp(`^:::\\s*${name}(\\(.*?\\))?\\n(.*?)\\n:::`, "gms")
		// Group 1 is args, if any. Group 2 is block content.
	}

	// TypeScript won't complain about not implementing this on subclasses because it's
	// a static method, but it should be on all of them (can't put abstract + static)
	static parse: (
		md: string,
		args: Record<string, unknown>
	) => Promise<
		{
			md: string
		} & Record<string, unknown>
	>
}

class HiddenBlock extends Block {
	static async parse(md: string) {
		const regex = this.getRegex("hidden")
		return { md: md.replaceAll(regex, "") }
	}
}

class DetailsBlock extends Block {
	/**
	 * Parse the contents of a :::details::: block.
	 * @param md The markdown to process
	 * @param processor A unified processor to convert the caption into HTML
	 * @returns An array of Detail objects, one for each line, and the modified markdown
	 */
	static async parse(
		md: string,
		args: { processor: Processor<Root, Root, Root, Root, string> }
	): Promise<{ md: string; details: Detail[] }> {
		// Convert only the first details block and leave all others untouched
		// so we remove the global flag. TODO: Maybe merge them all instead?
		const regex = new RegExp(this.getRegex("details"), "ms")
		const match = md.match(regex)
		if (!match) return { md, details: [] }

		// Delete the block from the page before errors happen
		md = md.replace(match[0], "")

		const contents = match[2]
		const details: Detail[] = []
		const detailLines = contents.split("\n").filter((line) => line !== "")

		for (const i in detailLines) {
			const index = parseInt(i)
			const line = detailLines[i]

			// Ignore empty lines
			if (line === "") continue

			// Split lines into key-value paris
			const split = line.split(/:\s*/)
			if (split.length === 0) {
				// Ignore broken formatting and emit a warning
				// Should never happen as we skip empty lines
				throw new Error(`Improperly formatted :::details:::`)
			}

			if (split.length === 1) {
				// Key-only details are valid
				const key = await args.processor.process(split[0])
				details.push({
					order: index + 1,
					key: key.toString(),
					value: null,
				})
			} else {
				// Both key and value. Make sure to handle excess splits due to additional
				// colons in the value, which are allowed
				const key = await args.processor.process(split[0])
				const preValue = split.splice(1).reduce((a, b) => a + ": " + b)
				const value = await args.processor.process(preValue)
				details.push({
					order: index + 1,
					key: key.toString(),
					value: value.toString(),
				})
			}
		}

		return { md, details }
	}
}

class ImageBlock extends Block {
	/**
	 * Parse the contents of an :::image::: block.
	 * @param md The markdown to process
	 * @param processor A unified processor to convert the caption into HTML
	 * @param imageNameToPath A Map linking image filenames into their path in the database
	 * @returns An array of SidebarImage objects and the modified markdown
	 */
	static async parse(
		md: string,
		args: {
			processor: Processor<Root, Root, Root, Root, string>
			imageNameToPath: Map<string, string>
		}
	) {
		const regex = this.getRegex("image")
		const matches = [...md.matchAll(regex)]
		if (matches.length === 0) return { md, images: [] }

		// An :::image::: block should be made up of 1 or 2 lines
		// The first is mandatory and is the wikilink to the image
		// The second is optional and is the caption
		// Any other line will be considered a part of the caption
		const images: SidebarImage[] = []
		for (const i in matches) {
			const index = parseInt(i)
			const match = matches[index]

			// Delete the block from the page before errors happen
			md = md.replace(match[0], "")

			// const maybeArgs = match[1]
			const contents = match[2]

			const lines = contents.split("\n").filter((line) => line !== "")
			if (lines.length === 0) {
				throw new Error(`Improperly formatted`)
			}

			// Grab the image filename from the wikilink
			const wikilink = lines[0].match(/!\[\[(.*?)(\|.*)?\]\]/)
			if (!wikilink) {
				throw new Error(`No image link`)
			}
			const imageFile = wikilink[1]

			// Grab the path of the current image
			const image_path = args.imageNameToPath.get(imageFile)
			if (!image_path) {
				throw new Error(
					`Could not find full path to image '${imageFile}'`
				)
			}

			// Then the caption, if present
			let caption: string | null
			if (lines.length > 1) {
				caption = lines.splice(1).join("\n")
				caption = (await args.processor.process(caption)).toString()
			} else {
				caption = null
			}

			images.push({
				order: index + 1,
				image_name: imageFile,
				image_path,
				caption,
			})
		}

		return { md, images }
	}
}

// Secret blocks are handled separately

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
 * @param imageNameToPath A map that links image filenames to their base64 representation
 * @returns The modified text, alongside all other additional data from custom blocks
 */
export async function replaceCustomBlocks(
	md: string,
	filename: string,
	processor: Processor<Root, Root, Root, Root, string>,
	imageNameToPath: Map<string, string>
) {
	// Remove :::hidden::: blocks
	const hiddenResult = await HiddenBlock.parse(md)
	md = hiddenResult.md

	// Parse and remove the first :::details::: block
	let details: Detail[] = []
	try {
		const detailsResult = await DetailsBlock.parse(md, { processor })
		md = detailsResult.md
		details = detailsResult.details
	} catch (error) {
		new Notice(`Error in ${filename}: ${error}`, 0)
		console.warn(`Error in ${filename}: ${error}`)
	}

	// Parse and remove :::image::: blocks
	let images: SidebarImage[] = []
	try {
		const imageResult = await ImageBlock.parse(md, {
			processor,
			imageNameToPath,
		})
		md = imageResult.md
		images = imageResult.images
	} catch (error) {
		new Notice(`Error in ${filename}: ${error}`, 0)
		console.warn(`Error in ${filename}: ${error}`)
	}

	return { md, details, sidebarImages: images }
}

/**
 * Split Markdown text into chunks with different user permission.
 * The text is split by :::secret::: and ![[transclusions]] blocks and
 * each is given the permission determined by the argument of the block.
 * @param text The text to split
 * @param imageNameToPath A mapping between image filenames and their path
 * @returns An array ContentChunks
 */
export function chunkMd(
	text: string,
	noteNameToPath: Map<string, { path: string; isExcalidraw: boolean }>,
	imageNameToPath: Map<string, string>
): ContentChunk[] {
	// First, partition by secrets while replacing each block with its contents
	const splits = partition(text, secretRegexNoGroups)

	// Get a list of the users mentioned in the blocks
	const secretUsers = [...text.matchAll(secretRegex)].map((match) => match[1])

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
			text = split.replace(secretRegex, "$2")
		} else {
			allowed_users = null
			text = split
		}

		tempChunks.push({
			chunk_id: idx + 1,
			text,
			allowed_users,
			image_path: null,
			note_transclusion_path: null,
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
			let note_transclusion_path: string | null = null
			let image_path: string | null = null
			if (idx % 2 === 1) {
				const refNameIdx = Math.floor(idx / 2)
				let linkName = linkNames[refNameIdx]
				const fileExtension = linkName.match(/\..*$/)

				if (fileExtension) {
					// Make sure to reference the svg and not the excalidraw files
					if (fileExtension[0] === ".excalidraw") {
						linkName = linkName + ".svg"
					}

					// The nullish coalescing also takes care of non-image file formats
					image_path = imageNameToPath.get(linkName) ?? null
				} else {
					const info = noteNameToPath.get(linkName)
					if (info?.isExcalidraw) {
						image_path = info.path + ".svg"
					} else {
						note_transclusion_path = info?.path ?? null
					}
				}
			}

			tempChunks2.push({
				chunk_id: idx + currOffset,
				text: image_path || note_transclusion_path ? "" : split,
				// Inherit allowed users from the current chunk
				allowed_users: chunk.allowed_users,
				image_path,
				note_transclusion_path,
			})
		}
	}

	return tempChunks2
}
