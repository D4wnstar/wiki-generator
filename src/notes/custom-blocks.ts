import { App, Notice } from "obsidian"
import { Detail, SidebarImage } from "../database/types"
import { mdToHtml } from "./text-transformations"
import { replaceAllAsync } from "src/utils"
import { RouteManager } from "src/commands"

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
	 * Check if the given string contains a block of this type.
	 */
	static contains(md: string) {
		return this.getRegex().test(md)
	}

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
			routes: RouteManager
			imageNameToPath: Map<string, string>
		}
	): Promise<{ md: string; details: Detail[] }> {
		// Grab only the first details block by removing the global flag,
		// then delete all others
		const match = md.match(new RegExp(this.getRegex(), "ms"))
		md = this.delete(md)
		if (!match) return { md, details: [] }

		const contents = match[2]
		const details: Detail[] = []
		const lines = contents
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "")

		// Four possibilities:
		// Key and value: normal display
		// Key with no value: key as a section header
		// No key with value: should not happen, ignore
		// No key and no value: horizontal line (<hr>)
		for (const [index, line] of lines.entries()) {
			const order = index + 1
			// A single hyphen means no key and no value, i.e. an <hr>
			if (line === "-") {
				details.push({
					order,
					key: null,
					value: null,
				})
				continue
			}

			// Split by colons. Any colon after the first is kept in the value
			const split = line.split(/:\s*/)

			let key = split.at(0)
			if (!key) continue
			key = await mdToHtml(
				key,
				args.app,
				args.routes,
				args.imageNameToPath,
				{ unwrap: true }
			)

			let value
			const values = split.slice(1)
			if (values.length > 0) {
				value = await mdToHtml(
					// Merge colons and turn semicolons into line breaks
					values.reduce((a, b) => a + ": " + b).replace(/;/g, "<br>"),
					args.app,
					args.routes,
					args.imageNameToPath,
					{ unwrap: true }
				)
			} else {
				value = null
			}

			details.push({ order, key, value })
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
			routes: RouteManager
			imageNameToPath: Map<string, string>
		}
	) {
		const regex = this.getRegex()
		const allMatches = [...md.matchAll(regex)]
		const matches = allMatches.filter((match) =>
			// Ignore anything that's not marked sidebar
			this.parseArgs(match[1] ?? "").includes("sidebar")
		)
		if (matches.length === 0) return { md, images: [] }

		// An :::image::: block should be made of an image embed optionally
		// followed by a caption
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
				args.routes,
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
			return `\n\n${wikilink}\n\n${captionTag}\n\n`
		})
	}

	private static async processBlock(
		contents: string,
		app: App,
		routes: RouteManager,
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
			caption = await mdToHtml(
				lines.splice(1).join("\n"),
				app,
				routes,
				imageNameToPath,
				{ unwrap: true }
			)
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
		titleToSlug: RouteManager,
		imageNameToPath: Map<string, string>
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
	routes: RouteManager,
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
	const isSecret = SecretBlock.contains(md)
	md = await SecretBlock.replace(md, app, routes, imageNameToPath)

	// Process inline :::image::: blocks
	md = await ImageBlock.replace(md)

	// Extract the first :::details::: block
	let details: Detail[] = []
	try {
		const extractedDetails = await DetailsBlock.extract(md, {
			app,
			routes,
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
			routes,
			imageNameToPath,
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
		isSecret,
		details,
		sidebarImages: images,
		math: { block: mathBlock, inline: mathInline },
	}
}
