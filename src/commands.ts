import { App, Notice, request, TFile, Vault } from "obsidian"
import { WikiGeneratorSettings } from "./settings"
import { createProgressBarFragment, getPublishableFiles } from "./utils"
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
import { wikilinkRegex } from "./notes/regexes"
import * as crypto from "crypto"
import { createClient } from "@libsql/client"
import { imageToArrayBuffer } from "./files/images"

const imageExtensions = ["png", "webp", "jpg", "jpeg", "gif", "bmp", "svg"]

/**
 * The central command of the plugin. Will traverse the entire vault, collecting all
 * notes and other files that can be inserted in the vault, determine which need to be
 * inserted or removed to keep the database synchronized, process each file depending on
 * its type and proceed with all the necessary database operations. If set, it will
 * also ping the Vercel deploy hook to inform the website to rebuild all static assets.
 * @param vault A reference to the vault
 * @param settings The plugin settings
 * @param reset Whether the database should be reset before uploading
 */
export async function syncNotes(
	vault: Vault,
	settings: WikiGeneratorSettings,
	reset = false
) {
	// Warn the user in case they don't have a deploy hook
	if (!settings.localExport && settings.deployHook.length === 0) {
		new Notice(
			"Deploy hook is not set. Notes will be uploaded, but website will not update. Make one in your Vercel dashboard and copy it in the settings.",
			10000
		)
	}

	console.log("-".repeat(5), "[WIKI GENERATOR UPLOAD START]", "-".repeat(5))

	const { fragment, updateProgress } = createProgressBarFragment()
	const notice = new Notice(fragment, 0)

	// Initialize common database interface
	const database = await initializeAdapter(settings, vault)

	try {
		if (reset) {
			updateProgress(5, "Clearing existing content...")
			console.log("Dropping all content tables...")
			await database.clearContent()
		}

		updateProgress(10, "Updating database...")
		console.log("Running migrations...")
		await database.runMigrations()

		updateProgress(20, "Collecting files...")
		console.log("Collecting files...")
		const files = await collectFiles(database, vault)

		updateProgress(35, "Collecting notes...")
		console.log("Collecting notes...")
		const notes = await collectNotes(database, vault)

		updateProgress(50, "Processing notes...")
		console.log("Processing notes...")
		const pagesToInsert = await processNotes(
			notes.toProcess,
			files.imageNameToPath,
			vault
		)

		updateProgress(65, "Syncing files...")
		const fileSync = await syncFiles(
			files.imagesToInsert,
			files.imagesToDelete,
			database,
			vault
		)

		updateProgress(80, "Syncing notes...")
		const imagePathsInDb = [
			...fileSync.insertedImagePaths,
			...files.existingImagePaths,
		]
		const pageSync = await syncPages(
			pagesToInsert,
			notes.toDelete,
			imagePathsInDb,
			database
		)

		updateProgress(90, "Updating settings...")
		console.log("Updating settings...")
		await database.updateSettings(settings)

		if (settings.localExport && settings.cloneRemoteUsers) {
			updateProgress(95, "Cloning user accounts...")
			console.log("Cloning user accounts from Turso...")
			const users = await getUsersFromRemote(
				settings.dbUrl,
				settings.dbToken
			)
			await database.insertUsers(users)
		}

		const { notice, changesMade } = makeEndResultNotice(pageSync, fileSync)

		if (settings.localExport) {
			updateProgress(98, "Exporting database...")
			console.log("Exporting database...")
			await database.export(vault)
			updateProgress(100, notice)
		} else {
			// Ping Vercel so it rebuilds the site, but only if something changed
			if (settings.deployOnSync && changesMade) {
				console.log("Sending POST request to deploy hook")
				await request({
					url: settings.deployHook,
					method: "POST",
				}).catch((error) => {
					console.error("Failed to ping deploy hook:", error)
				})
			}

			updateProgress(100, notice)
		}

		console.log(notice)
	} finally {
		setTimeout(() => notice.hide(), 5000)
		try {
			await database.close()
		} catch (error) {
			console.error("Failed to clean up adapter:", error)
		}
		console.log("-".repeat(5), "[WIKI GENERATOR UPLOAD END]", "-".repeat(5))
	}
}

async function collectFiles(database: DatabaseAdapter, vault: Vault) {
	// Get all images in the database
	const remoteImageHashes = new Map<string, string>()
	const remoteImagePaths = []
	for (const image of await database.getImageData()) {
		// In theory these should exist, but due to schema changes double checking is good
		if (!image.path || !image.hash) continue
		remoteImageHashes.set(image.path, image.hash)
		remoteImagePaths.push(image.path)
	}

	// First get all referenced images from markdown files
	const imageRefs = await getImageReferencesInVault(vault)

	// Collect only referenced images that have changed
	const imagesToInsert: {
		file: TFile
		hash: string
		type: "raster" | "svg"
	}[] = []
	const imagesToDelete: { path: string }[] = []
	const imageNameToPath: Map<string, string> = new Map()
	for (const file of vault.getFiles()) {
		if (imageExtensions.includes(file.extension)) {
			imageNameToPath.set(file.name, file.path)
			// Ignore and delete anything that's never mentioned in a markdown file
			if (!imageRefs.has(file.name)) {
				imagesToDelete.push({ path: file.path })
				continue
			}
			// Calculate the hash to ignore images that have not changed since last upload
			let buf: ArrayBuffer
			try {
				if (file.stat.size === 0) {
					console.warn(`Skipping empty file: ${file.path}`)
					continue
				}
				buf = await vault.readBinary(file)
				if (buf.byteLength === 0) {
					throw new Error("File read returned empty buffer")
				}
			} catch (error) {
				console.error(`Failed to read file ${file.path}:`, error)
				continue
			}

			// Recreate the buffer to avoid strip platform-specific artifacts which change hashes across platforms
			const cleanBuffer = new Uint8Array(buf).buffer
			const hash = crypto
				.createHash("sha256")
				.update(new Uint8Array(cleanBuffer))
				.digest("hex")

			const maybeExistingHash = remoteImageHashes.get(file.path)
			// If the file doesn't exist or it changed, insert/overwrite it
			if (!maybeExistingHash || hash !== maybeExistingHash) {
				const type = file.extension === "svg" ? "svg" : "raster"
				imagesToInsert.push({ file, hash, type })
			}
			// If it exists and it's identical to last time, don't bother reprocessing it
		} else {
			// Unsupported filetypes are skipped
			continue
		}
	}
	console.debug("Images to insert:", imagesToInsert)
	console.debug("Unreferenced images:", imagesToDelete)

	return {
		imagesToInsert,
		imagesToDelete,
		imageNameToPath,
		existingImagePaths: remoteImagePaths,
	}
}

async function collectNotes(database: DatabaseAdapter, vault: Vault) {
	// Fetch all markdown files and filter out ones that are unchanged since the last upload
	const remoteHashes = new Map<string, string>()
	const remoteNotes = await database.getNotes()
	for (const note of remoteNotes) {
		remoteHashes.set(note.path, note.hash)
	}
	const localPaths: Set<string> = new Set()

	const notesToProcess: { file: TFile; hash: string }[] = []
	for (const file of vault.getMarkdownFiles()) {
		localPaths.add(file.path)

		let content: string
		try {
			if (file.stat.size === 0) {
				console.warn(`Skipping empty note: ${file.path}`)
				continue
			}
			content = await vault.cachedRead(file)
			// Normalize line endings to prevent cross-platform mismatches
			content = content.replace(/\r\n/g, "\n")
		} catch (error) {
			console.error(`Failed to read note ${file.path}:`, error)
			continue
		}

		const hash = crypto.createHash("sha256").update(content).digest("hex")

		const maybeExistingHash = remoteHashes.get(file.path)
		if (!maybeExistingHash || hash !== maybeExistingHash) {
			// If the note doesn't exist or it changed, insert/overwrite it
			notesToProcess.push({ file, hash })
		}
		// If it exists and it's identical to last time, don't bother reprocessing it
	}

	// Delete notes that exist in remote but not in local
	const remotePaths = new Set(remoteHashes.keys())
	const notesToDelete = remotePaths.difference(localPaths)

	console.debug("Notes to process:", notesToProcess)
	console.debug("Notes to delete:", notesToDelete)

	return {
		toProcess: notesToProcess,
		toDelete: [...notesToDelete].map((path) => ({ path })),
	}
}

export interface FileSyncResult {
	insertedImagePaths: string[]
	insertedImages: number
	deletedImages: number
}

async function syncFiles(
	imagesToInsert: { file: TFile; hash: string; type: "raster" | "svg" }[],
	imagesToDelete: { path: string }[],
	database: DatabaseAdapter,
	vault: Vault
): Promise<FileSyncResult> {
	// Push the media to the database
	console.log(`Deleting unreferenced images...`)
	console.debug("Unreferenced images:", imagesToDelete)
	const deletedImages = await database.deleteImagesByPath(
		imagesToDelete.map((img) => img.path)
	)
	console.log(`Deleted ${deletedImages} images`)

	const imageRows = await Promise.all(
		imagesToInsert.map(async ({ file, hash, type }) => {
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
	console.log(`Inserting new or updated images...`)
	console.debug("New/updated images:", imageRows)
	const insertedImagePaths = await database.insertImages(imageRows)
	console.log(`Inserted ${insertedImagePaths.length} images`)

	return {
		insertedImagePaths,
		insertedImages: insertedImagePaths.length,
		deletedImages,
	}
}

async function processNotes(
	files: { file: TFile; hash: string }[],
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
	console.debug("Pages to insert:", pagesWithLinks)

	return pagesWithLinks
}

export interface PageSyncResult {
	insertedNotes: number
	deletedNotes: number
}

async function syncPages(
	pagesToInsert: Pages,
	pagesToDelete: { path: string }[],
	imagePathsInDb: string[],
	database: DatabaseAdapter
): Promise<PageSyncResult> {
	// Finally push the notes and media to the database
	console.log(`Deleting outdated notes...`)
	console.debug("Outdated notes:", pagesToDelete)
	const deletedNotes = await database.deleteNotesByPath(
		pagesToDelete.map((page) => page.path)
	)
	console.log(`Deleted ${deletedNotes} notes`)

	// Validate foreign key references before insertion
	validateForeignKeys(pagesToInsert, imagePathsInDb)
	console.log(`Inserting new or updated notes...`)
	console.debug("New/updated notes:", pagesToInsert)
	const insertedPages = await database.insertPages(pagesToInsert)
	console.log(`Inserted ${insertedPages} pages`)

	return { insertedNotes: insertedPages, deletedNotes }
}

/**
 * Get all image files referenced in markdown files
 * @param vault The vault instance
 * @returns Set of referenced image filenames
 */
async function getImageReferencesInVault(vault: Vault): Promise<Set<string>> {
	const files = vault.getMarkdownFiles()
	let refs = new Set<string>()

	for (const file of files) {
		try {
			// Scan each file for image filenames
			const content = await vault.cachedRead(file)
			refs = refs.union(getImageReferencesInString(content))
		} catch (error) {
			console.error(`Error reading ${file.path}:`, error)
		}
	}
	return refs
}

function getImageReferencesInString(text: string): Set<string> {
	const refs = new Set<string>()
	for (const match of text.matchAll(wikilinkRegex)) {
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

function makeEndResultNotice(
	pageSync: PageSyncResult,
	fileSync: FileSyncResult
) {
	const changesMade =
		pageSync.insertedNotes > 0 ||
		pageSync.deletedNotes > 0 ||
		fileSync.insertedImages > 0 ||
		fileSync.deletedImages > 0

	let notice = changesMade
		? "Done! Database synced."
		: "Done! No changes were necessary."
	if (pageSync.insertedNotes > 0) {
		const s = pageSync.insertedNotes > 1 ? "s" : ""
		notice += `\n- Updated ${pageSync.insertedNotes} note${s}.`
	}
	if (pageSync.deletedNotes > 0) {
		const s = pageSync.deletedNotes > 1 ? "s" : ""
		notice += `\n- Deleted ${pageSync.deletedNotes} outdated note${s}.`
	}
	if (fileSync.insertedImages > 0) {
		const s = fileSync.insertedImages > 1 ? "s" : ""
		notice += `\n- Updated ${fileSync.insertedImages} image${s}.`
	}
	if (fileSync.deletedImages > 0) {
		const s = fileSync.deletedImages > 1 ? "s" : ""
		notice += `\n- Deleted ${fileSync.deletedImages} outdated image${s}.`
	}

	return { notice, changesMade }
}

/**
 * Like `syncNotes`, except instead of syncing a diff of the entire vault, it forces the
 * sync of the note this command is ran on. Otherwise essentially identical to `syncNotes`.
 * This will also upload any files referenced in this note. It will not delete anything and
 * will not trigger a deployment.
 * @param note The file of the note to upload
 * @param vault A reference to the vault
 * @param settings The plugin settings
 */
export async function syncIndividualNote(
	note: TFile,
	vault: Vault,
	settings: WikiGeneratorSettings
) {
	console.log("-".repeat(5), "[WIKI GENERATOR UPLOAD START]", "-".repeat(5))
	const database = await initializeAdapter(settings, vault)
	try {
		const content = (await vault.cachedRead(note)).replace(/\r\n/g, "\n")
		const hash = crypto.createHash("sha256").update(content).digest("hex")

		const files = await collectFilesFromString(content, database, vault)
		const pageToInsert = await processNotes(
			[{ file: note, hash }],
			files.imageNameToPath,
			vault
		)
		const fileSync = await syncFiles(
			files.imagesToInsert,
			[],
			database,
			vault
		)
		const imagePathsInDb = [
			...fileSync.insertedImagePaths,
			...files.existingImagePaths,
		]
		await syncPages(pageToInsert, [], imagePathsInDb, database)

		if (settings.localExport) await database.export(vault)

		new Notice(
			"Successfully synced note. Use the 'Redeploy website' command to notify the website.",
			5000
		)
	} finally {
		try {
			await database.close()
		} catch (error) {
			console.error("Failed to clean up adapter:", error)
		}
		console.log("-".repeat(5), "[WIKI GENERATOR UPLOAD END]", "-".repeat(5))
	}
}

async function collectFilesFromString(
	text: string,
	database: DatabaseAdapter,
	vault: Vault
) {
	const imageRefs = getImageReferencesInString(text)
	const imageNameToPath = new Map<string, string>()
	const imagesToInsert: {
		file: TFile
		hash: string
		type: "raster" | "svg"
	}[] = []
	for (const file of vault.getFiles()) {
		if (!imageExtensions.includes(file.extension)) continue
		if (!imageRefs.has(file.name)) continue
		imageNameToPath.set(file.name, file.path)
		// Recreate the buffer to avoid strip platform-specific artifacts which change hashes across platforms
		const buf = new Uint8Array(await vault.readBinary(file)).buffer
		const hash = crypto
			.createHash("sha256")
			.update(new Uint8Array(buf))
			.digest("hex")
		const type = file.extension === "svg" ? "svg" : "raster"
		imagesToInsert.push({ file, hash, type })
	}

	const existingImagePaths = (await database.getImageData()).map(
		(img) => img.path
	)
	return {
		imagesToInsert,
		imageNameToPath,
		existingImagePaths,
	}
}

/**
 * Update the settings in the database without having to sync notes.
 * Will not trigger a deployment.
 * @param vault A reference to the vault
 * @param settings THe plugin settings
 */
export async function updateWikiSettings(
	vault: Vault,
	settings: WikiGeneratorSettings
) {
	const database = await initializeAdapter(settings, vault)
	try {
		await database.updateSettings(settings)
		if (settings.localExport) await database.export(vault)
		new Notice(
			"Successfully updated settings. Use the 'Redeploy website' command to notify the website.",
			5000
		)
	} catch (error) {
		console.error(`Error when updating settings: ${error}`)
		new Notice(`Error when updating settings: ${error}`)
		await database.close()
	}
}

/**
 * Add or set `wiki-publish: true` in all publishable files.
 * @param settings The plugin settings
 * @param app A reference to the app
 */
export async function massAddPublish(
	settings: WikiGeneratorSettings,
	app: App
) {
	const notes = getPublishableFiles(settings, app.vault)
	new Notice(`Adding 'wiki-publish' to all public notes`)
	for (const note of notes) {
		const contents = await app.vault.cachedRead(note)
		if (contents.includes("excalidraw-plugin:")) continue
		app.fileManager.processFrontMatter(note, (matter) => {
			if (!matter["wiki-publish"]) {
				matter["wiki-publish"] = true
			}
		})
	}
}

/**
 * Set all existing `wiki-publish` properties to the given value. Will not add the
 * property to files that do not have it. Use `massAddPublish` for that.
 * @param value The boolean value to set `wiki-publish` to
 * @param settings The plugin settings
 * @param app A reference to the app
 */
export async function massSetPublishState(
	value: boolean,
	settings: WikiGeneratorSettings,
	app: App
) {
	const notes = getPublishableFiles(settings, app.vault)
	for (const note of notes) {
		await app.fileManager.processFrontMatter(note, (matter) => {
			matter["wiki-publish"] = value
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
		try {
			await adapter.close()
		} catch (e) {
			console.error(`Error when closing adapter: ${e}`)
		}
	}
}

/**
 * Ping the Vercel deploy hook to trigger a new deployment.
 * @param settings The plugin settings
 */
export async function pingDeployHook(settings: WikiGeneratorSettings) {
	if (settings.deployHook) {
		await request({
			url: settings.deployHook,
			method: "POST",
		})
			.then(() => {
				new Notice(
					"Redeploying website. Check Vercel dashboard for further details."
				)
			})
			.catch((error) => {
				console.error("Failed to ping deploy hook:", error)
				new Notice(`Failed to redeploy website: ${error}`, 0)
			})
	} else {
		new Notice("No deploy hook is set. Please add one in the settings.")
	}
}
