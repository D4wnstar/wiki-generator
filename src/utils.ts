import { Notice, TFile, Vault } from "obsidian"
import { WikiGeneratorSettings } from "./settings"
import { slug } from "github-slugger"
import { checkForTemplateUpdates } from "./repository"

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
 * @param slug The b slug to check
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
		counter += 1
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
 * @example partition("This is an example", "is") === ["Th", "is", " ", "is", " an example"]
 * @example partition("This is an example", / +is +/) === ["This", "is", "an example"]
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
 * Check if a file is public or not by comparing its path with the public and private folders.
 * If the "restric folders" setting is inactive, this always returns `true`.
 * @param filepath The filepath to check
 * @param settings The plugin settings
 */
export function isFilePublic(
	filepath: string,
	settings: WikiGeneratorSettings
) {
	if (!settings.restrictFolders) return true

	const isPublic =
		settings.publicFolders.length === 0
			? true
			: settings.publicFolders.some((folder) =>
					filepath.startsWith(folder)
			  )
	const isPrivate =
		settings.privateFolders.length === 0
			? false
			: settings.privateFolders.some((folder) =>
					filepath.startsWith(folder)
			  )
	return isPublic && !isPrivate
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
	return vault
		.getMarkdownFiles()
		.filter((file) => isFilePublic(file.path, settings))
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

	// Add pulse animation styles
	const style = document.createElement("style")
	style.textContent = `
		@keyframes wiki-gen-pulse {
			0% { opacity: 1.0; }
			50% { opacity: 0.7; }
			100% { opacity: 1.0; }
		}
	`

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
	progressBar.style.animation = "wiki-gen-pulse 2.5s ease-in-out infinite"

	const progressText = document.createElement("div")
	progressText.style.marginTop = "4px"
	progressText.style.marginBottom = "8px"
	progressText.style.textAlign = "left"
	progressText.textContent = "Starting upload..."

	progressBarSlot.appendChild(progressBar)
	fragment.appendChild(style)
	fragment.appendChild(progressText)
	fragment.appendChild(progressBarSlot)

	const updateProgress = (percent: number, text: string) => {
		progressBar.style.width = `${percent}%`
		progressText.textContent = text
		console.debug(text)
	}

	return { fragment, updateProgress }
}

/**
 * Check if the website is up to date and show an notice with the result.
 * @param settings The plugin settings
 * @param noticeDuration The duration of the notice. Default 3 seconds
 * @param quietLevel How much output to mute. Level 1 removes "already up to date",
 * level 2 also removes "needs an update".
 */
export async function isWebsiteUpToDate(
	settings: WikiGeneratorSettings,
	options?: {
		noticeDuration?: number
		quietLevel?: number
	}
) {
	const noticeDuration = options?.noticeDuration ?? 3000
	const quiet = options?.quietLevel ?? 0

	if (!settings.githubUsername) {
		new Notice("The GitHub username is not set.", noticeDuration)
		return true
	} else if (!settings.githubRepoName) {
		new Notice("The GitHub repository name is not set.", noticeDuration)
		return true
	} else if (!settings.githubRepoToken) {
		new Notice("The GitHub repository token is not set.", noticeDuration)
		return true
	}

	try {
		const updates = await checkForTemplateUpdates(
			settings.githubRepoToken,
			settings.lastTemplateUpdate
		)
		if (updates.length === 0) {
			if (quiet < 1) {
				new Notice(
					"Your website is already up to date!",
					noticeDuration
				)
			}
			return true
		} else {
			if (quiet < 2)
				new Notice(
					"There is an update available for your website. Update it from the settings tab.",
					noticeDuration
				)
			return false
		}
	} catch (error) {
		const msg = error.response?.data?.message ?? error.message
		console.error(
			`Error ${error.status} when checking website updates: ${msg}`
		)
		new Notice(
			`There was an error while checking website updates: ${msg}`,
			noticeDuration * 2
		)
		return true
	}
}
