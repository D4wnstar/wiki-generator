import { Editor, TFile, TFolder, Vault, normalizePath } from "obsidian"
import { WikiGeneratorSettings } from "./settings"
import { globalVault } from "main"
import { ContentChunk } from "./notes/types"
import Image from "image-js"
import { slug } from "github-slugger"

export const calloutIcons = {
	info: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-info"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`,
	circleQuestion: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-help-circle"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>`,
	flame: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-flame"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`,
	check: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check"><path d="M20 6 9 17l-5-5"/></svg>`,
	circleCheck: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check-circle-2"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>`,
	cross: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
	zap: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-zap"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
	bug: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-bug"><path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/></svg>`,
	alertTriangle: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-alert-triangle"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`,
	list: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-list"><line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/></svg>`,
	quote: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-quote"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></svg>`,
	clipboard: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-clipboard-list"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/></svg>`,
}

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

/**
 * Helper to get the text of all chunks as a single string.
 * @param chunks An array of ContentChunks to join
 * @returns All the text of the chunks joined with no whitespace
 */
export function joinChunks(chunks: ContentChunk[]): string {
	let out = ""
	chunks.forEach((chunk) => (out += chunk.text))
	return out
}

export function resolveTFolder(folderPath: string) {
	const folderPathNorm = normalizePath(folderPath)
	const folder = globalVault.getAbstractFileByPath(folderPathNorm)

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
		return globalVault.getMarkdownFiles()
	}

	for (const folder of publicFolders) {
		const folderObj = resolveTFolder(folder)
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

export function getPublishableFiles(settings: WikiGeneratorSettings): TFile[] {
	let notes: TFile[]
	if (settings.restrictFolders) {
		notes = getFilesFromFolders(
			settings.publicFolders,
			settings.privateFolders
		)
	} else {
		notes = globalVault.getMarkdownFiles()
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
