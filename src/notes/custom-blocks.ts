import { Notice } from "obsidian"
import { Root } from "hast"
import { partition } from "src/utils"
import { Processor } from "unified"
import { Detail, SidebarImage, ContentChunk } from "../database/types"
import { transclusionRegex } from "./regexes"

interface WorkingContentChunk extends ContentChunk {
	locked: boolean
}

abstract class Block {
	static blockName: string

	protected static getRegex(): RegExp {
		return new RegExp(
			`^:::\\s*${this.blockName}(?:\\((.*?)\\))?\\n(.*?)\\n:::`,
			"gms"
		)
		// Group 1 is args, if any. Group 2 is block content.
		// General block syntax is
		//
		// :::block-name(maybe, args)
		// Block content here
		// On however many lines
		// ::::
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

	/**
	 * Removes content and returns additional data.
	 */
	static extract?: (
		md: string,
		args?: Record<string, any>
	) => Promise<
		{
			md: string
		} & Record<string, unknown>
	>

	/**
	 * Modifies content in-place by splitting into chunks with different data.
	 */
	static applyOnChunks?: (
		chunks: WorkingContentChunk[],
		args?: Record<string, any>
	) => Promise<
		{
			chunks: WorkingContentChunk[]
		} & Record<string, unknown>
	>

	/**
	 * Delete any block of this kind from the given string without parsing it.
	 */
	static delete: (md: string) => string
}

class HiddenBlock extends Block {
	static blockName = "hidden"

	static async extract(md: string) {
		const regex = this.getRegex()
		return { md: md.replaceAll(regex, "") }
	}
}

class DetailsBlock extends Block {
	static blockName = "details"

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
		const regex = new RegExp(this.getRegex(), "ms")
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
				// A single dash is used as an <hr> in the frontend
				const key =
					split[0] === "-"
						? ""
						: await args.processor.process(split[0])
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
	static blockName = "image"

	/**
	 * Parse the contents of an :::image::: block, but only if it has the "sidebar" argument.
	 * Inline images are handled by `applyOnChunks`.
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
		const regex = this.getRegex()
		const matches = [
			...md.matchAll(regex).filter((match) =>
				// Ignore anything that's not marked sidebar
				this.parseArgs(match.at(1) ?? "").includes("sidebar")
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
			const contents = match[2]

			// Delete the block from the page before errors happen
			md = md.replace(match[0], "")

			const { image_name, image_path, caption } = await this.processBlock(
				contents,
				args.processor,
				args.imageNameToPath
			)

			images.push({
				order: index + 1,
				image_name,
				image_path,
				caption,
			})
		}

		return { md, images }
	}

	/**
	 * Parse the contents of an :::image::: block, excluding ones with the "sidebar" argument.
	 * Sidebar images are handled by `extract`.
	 * @param chunks The chunks to process
	 * @param processor A unified processor to convert the caption into HTML
	 * @param imageNameToPath A Map linking image filenames into their path in the database
	 * @returns The modified chunks
	 */
	static async applyOnChunks(
		chunks: WorkingContentChunk[],
		args: {
			processor: Processor<Root, Root, Root, Root, string>
			imageNameToPath: Map<string, string>
		}
	) {
		const imageRegex = this.getRegex()
		const outChunks = []
		for (const chunk of chunks) {
			if (chunk.locked) {
				outChunks.push(chunk)
				continue
			}

			const splits = partition(chunk.text, imageRegex)

			if (splits.length === 1) {
				outChunks.push(chunk)
				continue
			}

			const newChunks: WorkingContentChunk[] = await Promise.all(
				splits.map(async (split) => {
					const newChunk: WorkingContentChunk = {
						...chunk,
						text: split.text,
						locked: split.matched,
					}

					const match = imageRegex.exec(split.text)
					if (!match) return newChunk

					const blockArgs = this.parseArgs(match.at(1) ?? "")
					if (blockArgs.includes("sidebar")) return newChunk

					const contents = match[2]
					const { image_path, caption } = await this.processBlock(
						contents,
						args.processor,
						args.imageNameToPath
					)
					return {
						...newChunk,
						text: split.matched ? caption ?? "" : newChunk.text,
						image_path: split.matched
							? image_path
							: chunk.image_path,
					}
				})
			)

			outChunks.push(...newChunks)
		}

		return { chunks: outChunks }
	}

	private static async processBlock(
		contents: string,
		processor: Processor<Root, Root, Root, Root, string>,
		imageNameToPath: Map<string, string>
	) {
		const lines = contents.split("\n").filter((line) => line !== "")
		if (lines.length === 0) {
			throw new Error(`Improperly formatted`)
		}

		// Grab the image filename from the wikilink
		const wikilink = lines[0].match(/!\[\[(.*?)(\|.*)?\]\]/)
		if (!wikilink) {
			throw new Error(`No image link`)
		}
		const image_name = wikilink[1]

		// Grab the path of the current image
		const image_path = imageNameToPath.get(image_name)
		if (!image_path) {
			throw new Error(`Could not find full path to image '${image_name}'`)
		}

		// Then the caption, if present
		let caption: string | null
		if (lines.length > 1) {
			caption = lines.splice(1).join("\n")
			caption = (await processor.process(caption)).toString()
		} else {
			caption = null
		}

		return { image_name, image_path, caption }
	}

	static delete(md: string) {
		const regex = this.getRegex()
		return md.replaceAll(regex, "")
	}
}

class SecretBlock extends Block {
	static blockName = "secret"

	static async applyOnChunks(chunks: WorkingContentChunk[]) {
		const secretRegex = this.getRegex()
		const outChunks = []
		for (const chunk of chunks) {
			if (chunk.locked) {
				outChunks.push(chunk)
				continue
			}

			// Partition by secrets while replacing each block with its contents
			const splits = partition(chunk.text, secretRegex)
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
				(split, idx) => ({
					...chunk,
					text: split.matched
						? split.text.replace(secretRegex, "$2")
						: split.text,
					allowed_users: split.matched
						? secretUsers[Math.floor(idx / 2)]
						: null,
				})
			)

			outChunks.push(...newChunks)
		}

		return { chunks: outChunks }
	}
}

// TODO: Remove chunk_id from everywhere since it's now unused
// (assigned based on array index instead)

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

			const splits = partition(chunk.text, transclusionRegex)
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
					text: split.matched ? "" : split.text,
					locked: split.matched,
				}
				if (!split.matched) {
					outChunks.push(newChunk)
					continue
				}

				let linkName = linkNames[Math.floor(idx / 2)]
				const fileExtension = linkName.match(/\..*$/)

				if (fileExtension) {
					// Make sure to reference the svg and not the excalidraw files
					if (fileExtension[0] === ".excalidraw") {
						linkName =
							linkName.replace(/\.excalidraw$/, "") + ".svg"
					}

					// The nullish coalescing also takes care of non-image file formats
					newChunk.image_path =
						args.imageNameToPath.get(linkName) ?? null
				} else {
					const info = args.noteNameToPath.get(linkName)
					if (info?.isExcalidraw) {
						newChunk.image_path =
							info.path.replace(/\.md$/, "") + ".svg"
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
	processor: Processor<any, any, any, any, any>,
	imageNameToPath: Map<string, string>,
	noteNameToPath: Map<string, { path: string; isExcalidraw: boolean }>
) {
	// Remove :::hidden::: blocks and Markdown comments
	md = md.replaceAll(/%%.*?%%/gs, "")
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
	md = md.replace(/^\$\$(.*?)\$\$$/gms, "$$$$\n$1\n$$$$")

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
	wChunks = await ImageBlock.applyOnChunks(wChunks.chunks, {
		processor,
		imageNameToPath,
	})
	wChunks = WikilinkTransclusion.applyOnChunks(wChunks.chunks, {
		imageNameToPath,
		noteNameToPath,
	})

	return { wChunks, details, sidebarImages: images }
}
