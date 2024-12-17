import { Editor, TFile, TFolder, Vault, normalizePath } from "obsidian"
import { WikiGeneratorSettings } from "./settings"
import Image from "image-js"
import { slug } from "github-slugger"

/**
 * Get the slug of a path by taking the slug of each path element separately.
 * Wants / as a separator, not \\.
 * @param path The path to get the slug
 * @returns The slug of the path
 */
export function slugPath(path: string): string {
	return path
		.replace(".md", "")
		.split("/")
		.map((s) => slug(s))
		.join("/")
}

/**
 * Splits the text by the splitter string and retains it in the return value, unlike `split`
 * which drops it. Assumes `splitter` exists in `text`.
 * @param text The text to partition
 * @param splitter The string to partition by. May be a RegExp with `g` flag and NO capture groups
 * @param limit Maximum number of splits done
 * @returns An array containing the partitioned text
 */
export function partition(
	text: string,
	splitter: string | RegExp,
	limit = -1
): string[] {
	if (limit === 0) {
		return [text]
	}

	const split = text.split(splitter)

	if (typeof splitter === "string") {
		const length = split.length
		for (let i = 1; i < length; i++) {
			if (i - 1 === limit) {
				split.slice(i).reduce((acc, curr, idx) => {
					if (idx < split.length - 1) {
						return acc + curr + splitter
					} else {
						return acc + curr
					}
				}, "")
			} else {
				split.splice(i, 0, splitter)
			}
		}
		return split
	} else {
		const matches = [...text.matchAll(splitter)]
		if (!matches || matches.length === 0) {
			return [text]
		}
		const out: string[] = []
		// Each step we mix a split and a match
		for (let i = 0; i < split.length; i++) {
			if (i === 0) {
				out.push(split[0])
			} else {
				// We drain the matches array bit by bit
				// Since split and matches are created by the same regex, we are guaranteed to
				// not shift() an empty array

				//@ts-ignore
				out.push(matches.shift()[0])
				if (i === limit) {
					// If we reach the limit, we reduce all of the remaining splits/matches into a string
					const rest = split.slice(limit).reduce((acc, curr) => {
						if (matches.length > 0) {
							//@ts-ignore
							const m = matches.shift()[0]
							return acc + curr + m
						} else {
							return acc + curr
						}
					}, "")
					out.push(rest)
					break
				} else {
					out.push(split[i])
				}
			}
		}

		return out
	}
}

/**
 * Convert an image from the Vault into webp, possibly downscaling it, and return its
 * base64 representation.
 * @param file The image's TFile
 * @param vault A reference to the Vault
 * @returns The base64 representation of the image
 */
export async function imageToBase64(
	file: TFile,
	vault: Vault,
	downscale: boolean
): Promise<string> {
	const buf = await vault.readBinary(file)
	let image = await Image.load(buf)
	if (downscale) {
		// Compress the image if it's overly large
		if (image.height > 1600) {
			image = image.resize({ height: 1600 })
		}
		if (image.width > 1600) {
			image = image.resize({ width: 1600 })
		}
	}
	return await image.toBase64("image/webp")
}

export function resolveTFolder(folderPath: string, vault: Vault) {
	const folderPathNorm = normalizePath(folderPath)
	const folder = vault.getAbstractFileByPath(folderPathNorm)

	if (folder instanceof TFolder) {
		return folder
	} else {
		throw new Error(
			`Could not find folder with path ${folderPathNorm}. Found ${folder}`
		)
	}
}

/**
 * Get all files in the vault within the given array of folders. Optionally give some
 * additional folders to filter out.
 * @param publicFolders The folders to get files from
 * @param privateFolders Optional argument. Files within these folders won't be returned
 * @returns An array of TFile objects
 */
export function getFilesFromFolders(
	vault: Vault,
	publicFolders: string[] | string,
	privateFolders?: string[]
): TFile[] {
	const files: TFile[] = []

	// Skip if given an empty string
	if (publicFolders instanceof String) {
		if (publicFolders.length === 0) {
			return []
		} else {
			publicFolders = <string[]>[publicFolders]
		}
	}

	// Consider no public folders as the entire vault so that you can use private folders
	// without having to set everything else as public manually
	if (publicFolders.length === 0) {
		return vault.getMarkdownFiles()
	}

	for (const folder of publicFolders) {
		const folderObj = resolveTFolder(folder, vault)
		Vault.recurseChildren(folderObj, (file) => {
			if (file instanceof TFile) {
				if (
					privateFolders &&
					privateFolders.some((path) => file.path.startsWith(path))
				) {
					return
				}

				files.push(file)
			}
		})
	}

	return files
}

export function getPublishableFiles(
	settings: WikiGeneratorSettings,
	vault: Vault
): TFile[] {
	let notes: TFile[]
	if (settings.restrictFolders) {
		notes = getFilesFromFolders(
			vault,
			settings.publicFolders,
			settings.privateFolders
		)
	} else {
		notes = vault.getMarkdownFiles()
	}

	return notes
}

export function getPropertiesFromEditor(editor: Editor): Map<string, string> {
	const contents = editor.getValue()
	const match = contents.match(/^---\n(.*?)\n---/s)
	if (!match) return new Map()

	const propsStrings = match[1].split("\n")
	const props = new Map<string, string>()
	for (const prop of propsStrings) {
		const [k, v] = prop.split(": ")
		props.set(k, v)
	}

	return props
}

export function replacePropertiesFromEditor(editor: Editor, newProps: string) {
	// Scuffed way to change properties. Why is there no API for this lmao

	// Check if there are any properties
	const startPos = { line: 0, ch: 0 }
	if (editor.getLine(0) !== "---") {
		// If not, just prepend the new ones to the file
		// Make sure new text ends with a newline
		if (!newProps.endsWith("\n")) newProps += "\n"
		editor.replaceRange(newProps, startPos)
		return
	}

	// If yes, check how many lines need to be replaced
	let i = 0
	for (; i < editor.lineCount(); i++) {
		const line = editor.getLine(i)
		if (i > 0 && line === "---") break
	}
	const endPos = { line: i, ch: 3 }

	// Finally, replace all characters between the start and the final line
	editor.replaceRange(newProps, startPos, endPos)
}
