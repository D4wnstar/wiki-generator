import { Notice, request, TFile, Vault } from "obsidian"
import { WikiGeneratorSettings } from "./settings"
import { getPublishableFiles, imageToArrayBuffer } from "./utils"
import { unified } from "unified"
import { createLocalDatabase, initializeAdapter } from "./database/init"
import {
	getUsersFromRemote,
	LocalDatabaseAdapter,
	RemoteDatabaseAdapter,
} from "./database/operations"
import {
	convertWikilinks,
	makePagesFromFiles,
} from "./notes/text-transformations"
import { DatabaseAdapter, Pages } from "./database/types"

import rehypeParse from "rehype-parse"
import rehypeWikilinks from "./unified/rehype-wikilinks"
import rehypeStringify from "rehype-stringify"
import { propsRegex, wikilinkRegex } from "./notes/regexes"
import * as crypto from "crypto"
import { createClient } from "@libsql/client"

const imageExtensions = ["png", "webp", "jpg", "jpeg", "gif", "bmp", "svg"]

export async function uploadNotes(
	vault: Vault,
	settings: WikiGeneratorSettings,
	reset = false
) {
	// Warn the user in case they don't have a deploy hook
	if (!settings.localExport && settings.deployHook.length === 0) {
		new Notice(
			"Deploy hook is not set. Notes will be uploaded, but website will not update. Check settings.",
			10000
		)
	}

	console.log("-".repeat(10), "[WIKI GENERATOR UPLOAD START]", "-".repeat(10))

	const { fragment, updateProgress } = createProgressBarFragment()
	const notice = new Notice(fragment, 0)

	// Initialize common database interface
	const adapter = await initializeAdapter(settings, vault)

	try {
		if (reset) {
			updateProgress(5, "Clearing existing content...")
			console.log("Dropping all content tables...")
			await adapter.clearContent()
		}

		updateProgress(10, "Running database migrations...")
		console.log("Running migrations...")
		await adapter.runMigrations()

		updateProgress(20, "Collecting images...")
		console.log("Collecting images...")
		const images = await collectMedia(adapter, vault)

		updateProgress(35, "Collecting notes...")
		console.log("Collecting notes...")
		const files = await collectNotes(adapter, vault)

		updateProgress(50, "Processing notes...")
		console.log("Processing notes...")
		const pages = await processNotes(files, images.nameToPath, vault)
		const uploadedNotes = pages.size

		updateProgress(65, "Uploading images...")
		console.log("Inserting images...")
		const insertedImagePaths = await insertMedia(
			images.files,
			adapter,
			vault
		)
		const uploadedImages = insertedImagePaths.length

		updateProgress(80, "Uploading notes...")
		console.log("Inserting notes...")
		const imagePathsInDb = [...insertedImagePaths, ...images.existingPaths]
		await insertNotes(pages, imagePathsInDb, adapter)

		updateProgress(90, "Updating settings...")
		console.log("Updating settings...")
		await adapter.updateSettings(settings)

		if (settings.localExport && !settings.ignoreUsers) {
			updateProgress(95, "Cloning user accounts...")
			console.log("Cloning user accounts from Turso...")
			const users = await getUsersFromRemote(
				settings.dbUrl,
				settings.dbToken
			)
			await adapter.insertUsers(users)
		}

		if (settings.localExport) {
			updateProgress(98, "Exporting database...")
			console.log("Exporting database...")
			await adapter.export(vault)
			updateProgress(
				100,
				`Exported ${uploadedNotes} notes and ${uploadedImages} images!`
			)
		} else {
			// Ping Vercel so it rebuilds the site, but only if something changed
			if (
				settings.deployHook &&
				(uploadedImages > 0 || uploadedNotes > 0)
			) {
				console.log("Sending POST request to deploy hook")
				await request({
					url: settings.deployHook,
					method: "POST",
				}).catch((error) => {
					console.error("Failed to ping deploy hook:", error)
				})
			}

			updateProgress(
				100,
				`Uploaded ${uploadedNotes} notes and ${uploadedImages} images!`
			)
		}
		setTimeout(() => notice.hide(), 3000)

		console.log(`Successfully uploaded ${uploadedNotes} notes`)
	} finally {
		try {
			await adapter.close()
		} catch (error) {
			console.error("Failed to clean up adapter:", error)
		}
		console.log(
			"-".repeat(10),
			"[WIKI GENERATOR UPLOAD END]",
			"-".repeat(10)
		)
	}
}

/**
 * Create a `DocumentFragment` representing a progress bar meant to be used in an
 * Obsidian notice with infinite duration. Hide the notice with its `.hide()` method
 * once you're the progress bar is at 100%.
 * @returns A `DocumentFragment` of the loading bar and a function to update it
 */
function createProgressBarFragment(): {
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

async function collectMedia(adapter: DatabaseAdapter, vault: Vault) {
	// Get all images in the database
	const existingImageHashes = new Map<string, string>()
	const existingImagePaths = []
	for (const image of await adapter.getImageData()) {
		// In theory these should exist, but due to schema changes double checking is good
		if (!image.path || !image.hash) continue
		existingImageHashes.set(image.path, image.hash)
		existingImagePaths.push(image.path)
	}

	// First get all referenced images from markdown files
	const imageRefs = await getReferencedImages(vault)

	// Collect only referenced images that have changed
	const images: { file: TFile; hash: string; type: "raster" | "svg" }[] = []
	const imageNameToPath: Map<string, string> = new Map()
	for (const file of vault.getFiles()) {
		if (imageExtensions.includes(file.extension)) {
			imageNameToPath.set(file.name, file.path)
			// Ignore anything that's never mentioned in a markdown file
			if (!imageRefs.has(file.name)) continue
			// Calculate the hash to ignore images that have not changed since last upload
			const buf = await vault.readBinary(file)
			const hash = crypto
				.createHash("sha256")
				.update(new Uint8Array(buf))
				.digest("hex")

			const maybeExistingHash = existingImageHashes.get(file.path)
			if (!maybeExistingHash || hash !== maybeExistingHash) {
				// If the file doesn't exist or it changed, insert/overwrite it
				const type = file.extension === "svg" ? "svg" : "raster"
				images.push({ file, hash, type })
			}
			// If it exists and it's identical to last time, don't bother reprocessing it
		} else {
			// Unsupported filetypes are skipped
			continue
		}
	}

	return {
		files: images,
		nameToPath: imageNameToPath,
		existingPaths: existingImagePaths,
	}
}

async function collectNotes(adapter: DatabaseAdapter, vault: Vault) {
	// Fetch all markdown files and filter out ones that are unchanged since the last upload
	const existingHashes = new Map<string, string>()
	const remoteNotes = await adapter.getNotes()
	for (const note of remoteNotes) {
		existingHashes.set(note.path, note.hash)
	}

	const files: { file: TFile; hash: string }[] = []
	for (const file of vault.getMarkdownFiles()) {
		const buf = await vault.readBinary(file)
		const hash = crypto
			.createHash("sha256")
			.update(new Uint8Array(buf))
			.digest("hex")

		const maybeExistingHash = existingHashes.get(file.path)
		if (!maybeExistingHash || hash !== maybeExistingHash) {
			// If the note doesn't exist or it changed, insert/overwrite it
			files.push({ file, hash })
		}
		// If it exists and it's identical to last time, don't bother reprocessing it
	}

	return files
}

async function insertMedia(
	images: { file: TFile; hash: string; type: "raster" | "svg" }[],
	adapter: DatabaseAdapter,
	vault: Vault
) {
	// Push the media to the database
	console.log(`Deleting ${images.length} outdated images...`)
	await adapter.deleteImagesByHashes(images.map((img) => img.hash))

	const imagesToInsert = await Promise.all(
		images.map(async ({ file, hash, type }) => {
			return {
				path: file.path.replace(/\.md$/, ""),
				alt: file.name,
				hash,
				buf:
					type === "raster"
						? await imageToArrayBuffer(file, vault, {
								downscale: true,
						  })
						: null,
				svg_text: type === "svg" ? await vault.cachedRead(file) : null,
			}
		})
	)
	console.log(`Inserting ${imagesToInsert.length} images...`)
	await adapter.insertImages(imagesToInsert)

	return imagesToInsert.map((img) => img.path)
}

async function processNotes(
	files: any,
	imageNameToPath: Map<string, string>,
	vault: Vault
) {
	// Convert them into rich data structures
	const { pages, titleToPath } = await makePagesFromFiles(
		files,
		imageNameToPath,
		vault
	)

	// Initialize one last processor to handle wikilink conversion
	const postprocessor = unified()
		.use(rehypeParse, { fragment: true })
		.use(rehypeWikilinks, titleToPath, imageNameToPath)
		.use(rehypeStringify, { allowDangerousHtml: true })

	console.log("Converting wikilinks...")
	const pagesWithLinks = await convertWikilinks(pages, postprocessor)

	return pagesWithLinks
}

async function insertNotes(
	pages: Pages,
	imagePathsInDb: string[],
	adapter: DatabaseAdapter
) {
	// Finally push the notes and media to the database
	console.log(`Deleting ${pages.size} outdated notes`)
	await adapter.deleteNotesByHashes([
		...pages.values().map((page) => page.note.hash),
	])

	// Validate foreign key references before insertion
	validateForeignKeys(pages, imagePathsInDb)
	console.log(`Inserting ${pages.size} notes...`)
	await adapter.pushPages(pages)
}

/**
 * Get all image files referenced in markdown files
 * @param vault The vault instance
 * @returns Set of referenced image filenames
 */
async function getReferencedImages(vault: Vault): Promise<Set<string>> {
	const files = vault.getMarkdownFiles()
	const refs = new Set<string>()

	for (const file of files) {
		try {
			// Scan all wikilinks for image filenames
			const content = await vault.cachedRead(file)
			for (const match of content.matchAll(wikilinkRegex)) {
				const filename = match[2]
				const extension = filename.match(/(?<=\.)[\w\d]+$/g)?.[0]

				if (extension && imageExtensions.includes(extension)) {
					refs.add(filename)
				} else if (extension === "excalidraw") {
					refs.add(filename + ".svg")
				} else if (!extension && match[1] /* is transclusion */) {
					// Since Excalidraw files are (very annoyingly) just markdown, it's
					// pretty much impossible to reliably distinguish Excalidraw transclusions from
					// generic note transclusions. As such, we optimistically assume any transclusion
					// without an extension is actually an Excalidraw file and add it to the refs.
					// Worst case scenario we add a bit too many images.
					refs.add(filename.replace(/\.md$/, "") + ".svg")
				}
			}
		} catch (error) {
			console.error(`Error reading ${file.path}:`, error)
		}
	}
	return refs
}

/**
 * Debug function to analyze the set of pages to upload before actually doing so.
 * This function will try to find inconsistencies in the foreign key handling. If any
 * such issues are found, it will throw, otherwise it won't do anything. The point of
 * this function isn't to avoid crashes, but rather to dump a bunch of error logs that
 * explain exactly what parts of which files are causing foreign key errors, as SQLite
 * only gives cryptic "error happened ¯\\_(ツ)_/¯" errors.
 * @param pages The Pages to analyze
 * @param images The set of images that goes alongside the pages
 */
function validateForeignKeys(pages: Pages, imagePathsInDb: string[]) {
	const missingRefs = new Map<string, string[]>()
	for (const [notePath, page] of pages.entries()) {
		const chunksWithIssues: string[] = []

		for (const [idx, chunk] of page.chunks.entries()) {
			if (
				chunk.note_transclusion_path &&
				!pages.has(chunk.note_transclusion_path)
			) {
				chunksWithIssues.push(
					`Chunk ${idx}: Missing transcluded note '${chunk.note_transclusion_path}'`
				)
			}
			if (chunk.image_path) {
				const imageExists = imagePathsInDb.some(
					(path) => path === chunk.image_path
				)
				if (!imageExists) {
					chunksWithIssues.push(
						`Chunk ${idx}: Missing image '${chunk.image_path}'`
					)
				}
			}
		}

		if (chunksWithIssues.length > 0) {
			missingRefs.set(notePath, chunksWithIssues)
		}
	}

	if (missingRefs.size > 0) {
		console.error("FOREIGN KEY constraint violations detected:")
		for (const [notePath, issues] of missingRefs.entries()) {
			let errorText = `- Note '${notePath}':`
			for (const issue of issues) {
				errorText += `\n|- ${issue}`
			}
			console.error(errorText)
		}
		throw new Error(
			"Cannot proceed with database insertion due to missing foreign key references. Press CTRL+SHIFT+I for more info."
		)
	}
}

/**
 * Add or set `wiki-publish: true` in all publishable files.
 * @param value The boolean value to set `wiki-publish` to
 * @param settings The plugin settings
 * @param vault A reference to the vault
 */
export function massAddPublish(
	value: boolean,
	settings: WikiGeneratorSettings,
	vault: Vault
) {
	const notes = getPublishableFiles(settings, vault)
	new Notice(`Adding 'wiki-publish' to all public notes`)
	for (const note of notes) {
		try {
			vault.process(note, (noteText) => {
				// Ignore Excalidraw files
				if (noteText.includes("excalidraw-plugin:")) return noteText

				// Isolate properties
				const props = noteText.match(propsRegex)
				if (props) {
					// Check if a publish property is already there
					const publish = props[1].match(
						/(wiki|dg)-publish: (true|false)/
					)
					// If it is, leave it as is
					if (publish) return noteText
					// Otherwise add a new property
					noteText = noteText.replace(
						propsRegex,
						`---\nwiki-publish: ${value}\n$1\n---`
					)
				} else {
					// If there are no properties, prepend a new publish one
					noteText = `---\nwiki-publish: ${value}\n---\n` + noteText
				}

				return noteText
			})
		} catch (e) {
			console.error(`Error when add wiki-publish to ${note.name}: ${e}`)
			new Notice(`Error when add wiki-publish to ${note.name}: ${e}`)
		}
	}
}

/**
 * Set all existing `wiki-publish` properties to the given value. Will not add the
 * property to files that do not have it. Use `massAddPublish` for that.
 * @param value The boolean value to set `wiki-publish` to
 * @param settings The plugin settings
 * @param vault A reference to the vault
 */
export function massSetPublishState(
	value: boolean,
	settings: WikiGeneratorSettings,
	vault: Vault
) {
	const notes = getPublishableFiles(settings, vault)
	const regex = RegExp(
		`^---\\n(.*?)wiki-publish: ${!value}(.*?)\\n---\\n`,
		"s"
	)
	for (const note of notes) {
		vault.process(note, (noteText) => {
			return noteText.replace(
				regex,
				`---\n$1wiki-publish: ${value}$2\n---\n`
			)
		})
	}
}

/**
 * Reset the database. This will drop all tables except user accounts and wiki settings.
 * @param settings The plugin settings
 * @param vault A reference to the Vault
 */
export async function resetDatabase(
	settings: WikiGeneratorSettings,
	vault: Vault
) {
	new Notice("Clearing database...")
	let adapter: DatabaseAdapter
	if (settings.localExport) {
		adapter = new LocalDatabaseAdapter(await createLocalDatabase(vault))
	} else {
		adapter = new RemoteDatabaseAdapter(
			createClient({
				url: settings.dbUrl,
				authToken: settings.dbToken,
			})
		)
	}

	try {
		await adapter.clearContent()
		await adapter.runMigrations()
		new Notice("Database cleared successfully.")
	} catch (e) {
		console.error(`Error when clearing database: ${e}`)
		new Notice(`Error when clearing database: ${e}`)
	} finally {
		await adapter.close()
	}
}
