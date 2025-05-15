import { Editor, TFile, TFolder, Vault, normalizePath } from "obsidian"
import { WikiGeneratorSettings } from "./settings"
import { slug } from "github-slugger"

interface ImageOptions {
	downscale?: boolean
	maxDimension?: number
	quality?: number
}

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
 * Ensure a slug is unique by appending incrementing numbers when collisions occur.
 * @param slug The base slug to check
 * @param existingSlugs Set of existing slugs to check against
 * @returns A unique version of the slug
 * @example ensureUniqueSlug("hello", new Set(["hello"])) -> "hello-1"
 * @example ensureUniqueSlug("hello", new Set(["hello", "hello-1"])) -> "hello-2"
 */
export function ensureUniqueSlug(
	slug: string,
	existingSlugs: Set<string>
): string {
	if (!existingSlugs.has(slug)) {
		return slug
	}

	let counter = 1
	let newSlug = `${slug}-${counter}`
	while (existingSlugs.has(newSlug)) {
		counter++
		newSlug = `${slug}-${counter}`
	}
	return newSlug
}

/**
 * Splits the text by the splitter while retaining the splitter in the result.
 * @param text The text to partition
 * @param splitter The string or RegExp to partition by. If a RegExp, must have the 'g' flag.
 * @param options Configuration options
 * @param options.limit Maximum number of splits to perform (-1 for unlimited)
 * @returns An array containing the partitioned text alongside whether that piece was a match or not
 */
export function partition(
	text: string,
	splitter: string | RegExp,
	options: {
		limit?: number
	} = { limit: -1 }
): { text: string; matched: boolean }[] {
	options.limit = options.limit ?? -1
	if (options.limit === 0) {
		return [{ text, matched: false }]
	}

	// Convert string splitter to regex with capture group
	const regex =
		typeof splitter === "string"
			? new RegExp(`(${escapeRegExp(splitter)})`, "g")
			: splitter

	// Ensure regex has global flag
	if (!regex.global) {
		throw new Error("RegExp splitter must have the global (g) flag")
	}

	const result: { text: string; matched: boolean }[] = []
	let lastIndex = 0
	let splitCount = 0
	const matches = [...text.matchAll(regex)]

	for (const match of matches) {
		if (options.limit >= 0 && splitCount >= options.limit) {
			break
		}

		// Add text before match
		if (match.index > lastIndex) {
			result.push({
				text: text.slice(lastIndex, match.index),
				matched: false,
			})
		}

		// Add the match itself
		result.push({ text: match[0], matched: true })
		lastIndex = match.index + match[0].length
		splitCount += 1
	}

	// Add remaining text
	if (lastIndex < text.length) {
		result.push({ text: text.slice(lastIndex), matched: false })
	}

	// Handle case where there were no matches
	if (result.length === 0) {
		return [{ text, matched: false }]
	}

	return result
}

// Helper to escape regex special characters in strings
function escapeRegExp(string: string): string {
	return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Like `String.prototype.replaceAll`, but allows an async replacement function.
 * ```javascript
 * replaceAllAsync(text, regexp, replacer) === text.replaceAll(regexp, replacer)
 * ```
 */
export async function replaceAllAsync(
	text: string,
	regexp: RegExp,
	replacer: (substring: string, ...args: any[]) => Promise<string>
) {
	const matches = [...text.matchAll(regexp)]
	const processed = await Promise.all(
		matches.map((match) => replacer(match[0], ...match.slice(1)))
	)
	return matches.reduce(
		(str, match, i) => str.replace(match[0], processed[i]),
		text
	)
}

/**
 * Convert an image from the Vault into webp, possibly downscaling it, and return its
 * Blob representation.
 * @param file The image's TFile
 * @param vault A reference to the Vault
 * @param options Configuration options for image processing
 * @returns A Promise resolving to the image's ArrayBuffer
 */
export async function imageToArrayBuffer(
	file: TFile,
	vault: Vault,
	options: ImageOptions = {}
): Promise<ArrayBuffer> {
	const { downscale = true, maxDimension = 1600, quality = 80 } = options

	try {
		const buf = await vault.readBinary(file)

		// Create image element
		const img = new Image()
		const url = URL.createObjectURL(new Blob([buf]))

		// Wait for image to load
		await new Promise((resolve, reject) => {
			img.onload = resolve
			img.onerror = () => reject(new Error("Failed to load image"))
			img.src = url
		})

		// Create canvas for resizing
		const canvas = document.createElement("canvas")
		let width = img.width
		let height = img.height

		if (downscale) {
			if (width > maxDimension || height > maxDimension) {
				const ratio = Math.min(
					maxDimension / width,
					maxDimension / height
				)
				width = Math.floor(width * ratio)
				height = Math.floor(height * ratio)
			}
		}

		canvas.width = width
		canvas.height = height

		// Draw resized image
		const ctx = canvas.getContext("2d")
		if (!ctx) throw new Error("Could not get canvas context")
		ctx.drawImage(img, 0, 0, width, height)

		// Convert to WebP
		return new Promise((resolve) => {
			canvas.toBlob(
				(blob) => {
					URL.revokeObjectURL(url)
					if (!blob) throw new Error("Conversion failed")
					blob.arrayBuffer().then(resolve)
				},
				"image/webp",
				quality / 100
			)
		})
	} catch (error) {
		console.error("Image processing error:", error)
		throw error
	}
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
 * Get all files in the vault that are in the whitelisted folders and not in the blacklisted
 * folders.
 * @param whitelist Path array of folders to get files from. No public folders means the entire vault.
 * @param blacklist Path array of folders to ignore files form.
 * @returns An array of TFile objects
 */
export function getFilesFromFolders(
	vault: Vault,
	whitelist: string[] = [],
	blacklist: string[] = []
): TFile[] {
	// Consider no public folders as the entire vault so that you can use private folders
	// without having to set everything else as public
	return vault.getMarkdownFiles().filter((file) => {
		const isPrivate =
			blacklist.length === 0
				? false
				: blacklist.some((path) => file.path.startsWith(path))
		const isPublic =
			whitelist.length === 0
				? true
				: whitelist.some((path) => file.path.startsWith(path))
		return isPublic && !isPrivate
	})
}

/**
 * Get a list of Markdown files that have a truthy `wiki-publish` property.
 * @param settings The Obsidian settings
 * @param vault A reference to the vault
 * @returns An array of Markdown files with truthy `wiki-publish` property
 */
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

/**
 * Create a `DocumentFragment` representing a progress bar meant to be used in an
 * Obsidian notice with infinite duration. Hide the notice with its `.hide()` method
 * once the progress bar is at 100%.
 * @returns A `DocumentFragment` of the loading bar and a function to update it
 */
export function createProgressBarFragment(): {
	fragment: DocumentFragment
	updateProgress: (percent: number, text: string) => void
} {
	const fragment = new DocumentFragment()
	const progressBarSlot = document.createElement("div")
	progressBarSlot.style.width = "100%"
	progressBarSlot.style.height = "4px"
	progressBarSlot.style.backgroundColor = "var(--background-secondary)"
	progressBarSlot.style.borderRadius = "10px"
	progressBarSlot.style.overflow = "hidden"

	const progressBar = document.createElement("div")
	progressBar.style.width = "0%"
	progressBar.style.height = "100%"
	progressBar.style.backgroundColor = "var(--interactive-accent)"
	progressBar.style.transition = "width 0.3s ease"

	const progressText = document.createElement("div")
	progressText.style.marginTop = "4px"
	progressText.style.marginBottom = "8px"
	progressText.style.textAlign = "center"
	progressText.textContent = "Starting upload..."

	progressBarSlot.appendChild(progressBar)
	fragment.appendChild(progressText)
	fragment.appendChild(progressBarSlot)

	const updateProgress = (percent: number, text: string) => {
		progressBar.style.width = `${percent}%`
		progressText.textContent = text
	}

	return { fragment, updateProgress }
}
