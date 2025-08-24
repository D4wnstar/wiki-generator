import { App, Notice } from "obsidian"
import { Detail, SidebarImage } from "../database/types"
import { mdToHtml } from "./text-transformations"
import { replaceAllAsync } from "src/utils"

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
	 * Delete any block of this kind from the given string without parsing it.
	 */
	static delete(md: string) {
		return md.replace(this.getRegex(), "")
	}
}

class HiddenBlock extends Block {
	static blockName = "hidden"
}

class DetailsBlock extends Block {
	static blockName = "details"

	/**
	 * Parse the contents of a :::details::: block.
	 * @param md The markdown to process
	 * @returns An array of Detail objects, one for each line, and the modified markdown
	 */
	static async extract(
		md: string,
		args: {
			app: App
			titleToSlug: Map<string, string>
			imageNameToPath: Map<string, string>
		}
	): Promise<{ md: string; details: Detail[] }> {
		// Grab the first details block only by removing the global flag
		const match = md.match(new RegExp(this.getRegex(), "ms"))
		if (!match) return { md, details: [] }

		// Delete all details blocks. Any block after the first is ignored
		md = this.delete(md)

		const contents = match[2]
		const details: Detail[] = []
		const detailLines = contents.split("\n").filter((line) => line !== "")

		for (const [index, line] of detailLines.entries()) {
			// Split lines into key-value pairs
			const split = line.split(/:\s*/)
			if (split.length === 0) {
				// Should never happen as we skip empty lines
				throw new Error(`Improperly formatted :::details:::`)
			}

			if (split.length === 1) {
				// Key-only details are valid
				const key =
					split[0] === "-" // A single dash is used as an <hr> in the frontend
						? ""
						: await mdToHtml(
								split[0],
								args.app,
								args.titleToSlug,
								args.imageNameToPath
						  )
				details.push({
					order: index + 1,
					key,
					value: null,
				})
			} else {
				// Both key and value. Make sure to handle excess splits due to additional
				// colons in the value, which are allowed
				const key = await mdToHtml(
					split[0],
					args.app,
					args.titleToSlug,
					args.imageNameToPath
				)
				const preValue = split.splice(1).reduce((a, b) => a + ": " + b)
				const value = await mdToHtml(
					preValue,
					args.app,
					args.titleToSlug,
					args.imageNameToPath
				)
				details.push({
					order: index + 1,
					key,
					value,
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
	 * Inline images are handled by `applyOnText`.
	 * @param md The markdown to process
	 * @param app The Obsidian app instance
	 * @param imageNameToPath A Map linking image filenames into their path in the database
	 * @returns An array of SidebarImage objects and the modified markdown
	 */
	static async extract(
		md: string,
		args: {
			app: App
			imageNameToPath: Map<string, string>
			titleToSlug: Map<string, string>
		}
	) {
		const regex = this.getRegex()
		const allMatches = [...md.matchAll(regex)]
		const matches = allMatches.filter((match) =>
			// Ignore anything that's not marked sidebar
			this.parseArgs(match[1] ?? "").includes("sidebar")
		)
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
				args.app,
				args.imageNameToPath,
				args.titleToSlug
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
	 */
	static async replace(md: string) {
		return md.replace(this.getRegex(), (match, args, content) => {
			// Leave sidebar content alone
			if (args?.includes("sidebar")) return match

			// Let the Obsidian renderer handle the ![[wikilink]] -> <img> conversion
			// but mark the caption manually
			const lines = content.split("\n")
			const wikilink = lines[0]
			const caption = lines.slice(1).join("\n")
			const captionTag = `<p class="image-caption">${caption}</p>`
			return "\n\n" + wikilink + captionTag
		})
	}

	private static async processBlock(
		contents: string,
		app: App,
		imageNameToPath: Map<string, string>,
		titleToSlug: Map<string, string>
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
			caption = await mdToHtml(caption, app, titleToSlug, imageNameToPath)
		} else {
			caption = null
		}

		return { image_name, image_path, caption }
	}
}

class SecretBlock extends Block {
	static blockName = "secret"

	/**
	 * Process secret blocks by wrapping content in div with the `data-allowed-users`
	 * attribute, which is a semi-color separated list of usernames.
	 */
	static async replace(
		md: string,
		app: App,
		imageNameToPath: Map<string, string>,
		titleToSlug: Map<string, string>
	) {
		return await replaceAllAsync(
			md,
			this.getRegex(),
			async (match, args, content) => {
				if (!args) return match
				const users = (args as string)
					.split(",")
					.map((s) => s.trim())
					.join(";")

				const html = await mdToHtml(
					content,
					app,
					titleToSlug,
					imageNameToPath
				)

				return `\n\n<section class="secret-block" data-allowed-users="${users}"><header class="secret-block-header">Secret</header><div class="secret-block-content">${html}</div></section>\n\n`
			}
		)
	}
}

/**
 * Parse Markdown text for custom syntax that's not handled by Obsidian already,
 * such as custom :::blocks::: and separate handling of math and Mermaid graphs.
 *
 * @param md The markdown text to transform
 * @param filename The name of the file that's being processed
 * @param app The Obsidian app instance
 * @param imageNameToPath A map that links image filenames to their vault path
 * @param noteNameToPath A map that links note filenames to their vault path
 * @returns The modified text, alongside all other additional data from custom blocks
 */
export async function handleCustomSyntax(
	md: string,
	filename: string,
	app: App,
	titleToSlug: Map<string, string>,
	imageNameToPath: Map<string, string>
) {
	// Anything in codeblocks should be ignored, so remove them and put them back later
	const codeRegex = /^```.*\n[^]*?\n```/gm
	const codeblocks = Array.from(md.matchAll(codeRegex)).reverse()
	md = md.replace(codeRegex, "|codeblock|")

	// Remove :::hidden::: blocks and Markdown comments
	md = md.replace(/%%.*?%%/gs, "")
	md = HiddenBlock.delete(md)

	// Process :::secret::: blocks
	md = await SecretBlock.replace(md, app, titleToSlug, imageNameToPath)

	// Process inline :::image::: blocks
	md = await ImageBlock.replace(md)

	// Extract the first :::details::: block
	let details: Detail[] = []
	try {
		const extractedDetails = await DetailsBlock.extract(md, {
			app,
			titleToSlug,
			imageNameToPath,
		})
		md = extractedDetails.md
		details = extractedDetails.details
	} catch (error) {
		new Notice(`Error parsing :::details::: in ${filename}: ${error}`, 0)
		console.warn(`Error parsing :::details::: in ${filename}: ${error}`)
	}

	// Extract sidebar :::image::: blocks
	let images: SidebarImage[] = []
	try {
		const extractedImages = await ImageBlock.extract(md, {
			app,
			imageNameToPath,
			titleToSlug,
		})
		md = extractedImages.md
		images = extractedImages.images
	} catch (error) {
		new Notice(`Error parsing :::image::: in ${filename}: ${error}`, 0)
		console.warn(`Error parsing :::image::: in ${filename}: ${error}`)
	}

	// Bypass MathJax entirely and use KaTeX instead
	const mathBlock = Array.from(md.matchAll(/\$\$(.*?)\$\$/gs))
		.map((block) =>
			block[1]
				.replace(/^>\s+/gm, "")
				.replace("\n", "")
				.replace(
					/\\(begin|end)\{(equation|gather|align|alignat)\}/g,
					"\\$1{$2*}"
				)
		)
		.reverse()
	md = md
		.replace(/\$\$.*?\$\$/gs, "|math|")
		.replace(/^\|math\|/gm, "\n|math|\n")
	const mathInline = Array.from(md.matchAll(/\$(.*?)\$/g))
		.map((code) => code[1])
		.reverse()
	md = md.replace(/\$.*?\$/g, "|math-inline|")

	// Put the codeblocks back
	md = md.replace(/^\|codeblock\|/gm, () => codeblocks.pop()?.[0] ?? "")

	// Manually replace Mermaid codeblocks before PrismJS messes up the formatting
	md = md.replace(/```mermaid\n(.*?)\n```/gs, '<pre class="mermaid">$1</pre>')

	return {
		md,
		details,
		sidebarImages: images,
		math: { block: mathBlock, inline: mathInline },
	}
}
