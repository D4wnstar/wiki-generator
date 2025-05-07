import { Notice } from "obsidian"
import { Root } from "hast"
import { partition } from "src/utils"
import { Processor } from "unified"
import { Detail, SidebarImage, ContentChunk } from "../database/types"
import {
	secretRegexNoGroups,
	transclusionRegex,
	transclusionRegexNoGroups,
} from "./regexes"

interface WorkingContentChunk extends ContentChunk {
	locked: boolean
}

abstract class Block {
	protected static getRegex(name: string): RegExp {
		return new RegExp(`^:::\\s*${name}(\\(.*?\\))?\\n(.*?)\\n:::`, "gms")
		// Group 1 is args, if any. Group 2 is block content.
	}

	/**
	 * Parse the block arguments and return an array of them.
	 * @param args The string of arguments, ideally as given by the capture group from getRegex
	 * @returns An array of arguments
	 */
	protected static parseArgs(args: string): string[] {
		return args.split(",").map((arg) => arg.toLowerCase().trim())
	}

	// TypeScript won't complain about not implementing parse methods on subclasses because they
	// are static methods, but they should be on all of them (can't put abstract + static)

	// Removes content and returns additional data
	static extract?: (
		md: string,
		args?: Record<string, any>
	) => Promise<
		{
			md: string
		} & Record<string, unknown>
	>

	// Modifies content in-place by splitting into chunks with different data
	static applyOnChunks?: (
		chunks: WorkingContentChunk[],
		args?: Record<string, any>
	) => Promise<
		{
			chunks: WorkingContentChunk[]
		} & Record<string, unknown>
	>
}

class HiddenBlock extends Block {
	static async extract(md: string) {
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
	static async extract(
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
	 * Parse the contents of an :::image::: block, but only if it has the "sidebar" argument.
	 * Inline images are nadled by applyOnChunks
	 * @param md The markdown to process
	 * @param processor A unified processor to convert the caption into HTML
	 * @param imageNameToPath A Map linking image filenames into their path in the database
	 * @returns An array of SidebarImage objects and the modified markdown
	 */
	static async extract(
		md: string,
		args: {
			processor: Processor<Root, Root, Root, Root, string>
			imageNameToPath: Map<string, string>
		}
	) {
		const regex = this.getRegex("image")
		const matches = [
			...md.matchAll(regex).filter((match) =>
				// Ignore anything that's not marked sidebar
				this.parseArgs(match[1]).includes("sidebar")
			),
		]
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

	// TODO: Implement applyOnChunks for non-sidebar images
}

class SecretBlock extends Block {
	static async applyOnChunks(chunks: WorkingContentChunk[]) {
		const secretRegex = this.getRegex("secret")
		const outChunks = []
		for (const chunk of chunks) {
			if (chunk.locked) {
				outChunks.push(chunk)
				continue
			}

			// Partition by secrets while replacing each block with its contents
			const splits = partition(chunk.text, secretRegexNoGroups)
			if (splits.length === 1) {
				outChunks.push(chunk)
				continue
			}

			// Get a list of the users mentioned in the blocks
			const secretUsers = [...chunk.text.matchAll(secretRegex)].map(
				(match) =>
					match[1]
						.split(",")
						.map((s) => s.trim())
						.join(";")
			)

			const newChunks: WorkingContentChunk[] = splits.map(
				(text, idx) => ({
					...chunk,
					chunk_id: chunk.chunk_id + idx,
					text:
						idx % 2 === 1 ? text.replace(secretRegex, "$2") : text,
					allowed_users:
						idx % 2 === 1 ? secretUsers[Math.floor(idx / 2)] : null,
				})
			)

			outChunks.push(...newChunks)
		}

		return { chunks }
	}
}

// TODO: Use the order of the chunk array for the ids instead of assigning them here

// A bit of a "fake" block in that it does not actually inherit from Block but the
// use case is the same
class WikilinkTransclusion {
	static applyOnChunks(
		chunks: WorkingContentChunk[],
		args: {
			imageNameToPath: Map<string, string>
			noteNameToPath: Map<string, { path: string; isExcalidraw: boolean }>
		}
	) {
		const outChunks = []
		for (const chunk of chunks) {
			if (chunk.locked) {
				outChunks.push(chunk)
				continue
			}

			const splits = partition(chunk.text, transclusionRegexNoGroups)
			if (splits.length === 1) {
				outChunks.push(chunk)
				continue
			}

			const linkNames = [...chunk.text.matchAll(transclusionRegex)].map(
				(match) => match[1]
			)

			for (const [idx, split] of splits.entries()) {
				const newChunk: WorkingContentChunk = {
					...chunk,
					text: idx % 2 === 1 ? "" : split,
					chunk_id: chunk.chunk_id + idx,
					locked: idx % 2 === 1,
				}
				if (idx % 2 !== 1) {
					outChunks.push(newChunk)
					continue
				}

				let linkName = linkNames[Math.floor(idx / 2)]
				const fileExtension = linkName.match(/\..*$/)

				if (fileExtension) {
					// Make sure to reference the svg and not the excalidraw files
					if (fileExtension[0] === ".excalidraw") {
						linkName = linkName + ".svg"
					}

					// The nullish coalescing also takes care of non-image file formats
					newChunk.image_path =
						args.imageNameToPath.get(linkName) ?? null
				} else {
					const info = args.noteNameToPath.get(linkName)
					if (info?.isExcalidraw) {
						newChunk.image_path = info.path + ".svg"
					} else {
						newChunk.note_transclusion_path = info?.path ?? null
					}
				}

				outChunks.push(newChunk)
			}
		}

		return { chunks: outChunks }
	}
}

/**
 * Parse Markdown text for custom syntax that's not handled by remark already,
 * mostly custom :::blocks::: and Obsidian transclusions.
 *
 * Use the `chunkMd` function to split the page by those.
 * @param md The markdown text to transform
 * @param filename The name of the file that's being processed
 * @param processor A unified processor to convert Markdown into HTML
 * @param imageNameToPath A map that links image filenames to their vault path
 * @param noteNameToPath A map that links note filenames to their vault path
 * @returns The modified text, alongside all other additional data from custom blocks
 */
export async function handleCustomSyntax(
	md: string,
	filename: string,
	processor: Processor<Root, Root, Root, Root, string>,
	imageNameToPath: Map<string, string>,
	noteNameToPath: Map<string, { path: string; isExcalidraw: boolean }>
) {
	// Remove :::hidden::: blocks and Markdown comments
	md = md.replace(/%%.*?%%/gs, "")
	md = (await HiddenBlock.extract(md)).md

	// Parse and remove the first :::details::: block
	let details: Detail[] = []
	try {
		const extractedDetails = await DetailsBlock.extract(md, { processor })
		md = extractedDetails.md
		details = extractedDetails.details
	} catch (error) {
		new Notice(`Error parsing :::details::: in ${filename}: ${error}`, 0)
		console.warn(`Error parsing :::details::: in ${filename}: ${error}`)
	}

	// Parse and remove :::image::: blocks
	let images: SidebarImage[] = []
	try {
		const extractedImages = await ImageBlock.extract(md, {
			processor,
			imageNameToPath,
		})
		md = extractedImages.md
		images = extractedImages.images
	} catch (error) {
		new Notice(`Error parsing :::image::: in ${filename}: ${error}`, 0)
		console.warn(`Error parsing :::image::: in ${filename}: ${error}`)
	}

	// remarkMath needs newlines to consider a math block as display
	// The quadruple $ is because $ is the backreference character in
	// regexes and is escaped as $$, so $$$$ -> $$
	md = md.replace(/^\$\$/gm, "$$$$\n").replace(/\$\$$/gm, "\n$$$$")

	// Handle chunking
	const initialChunk: WorkingContentChunk = {
		chunk_id: 1,
		text: md,
		allowed_users: null,
		image_path: null,
		note_transclusion_path: null,
		locked: false,
	}
	let wChunks = await SecretBlock.applyOnChunks([initialChunk])
	wChunks = WikilinkTransclusion.applyOnChunks(wChunks.chunks, {
		imageNameToPath,
		noteNameToPath,
	})

	return { wChunks, details, sidebarImages: images }
}
