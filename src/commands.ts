import { App, Notice, request, TFile, Vault } from "obsidian"
import { WikiGeneratorSettings } from "./settings"
import { createProgressBarFragment, getPublishableFiles } from "./utils"
import { createLocalDatabase, initializeAdapter } from "./database/init"
import {
	getUsersFromRemote,
	LocalDatabaseAdapter,
	RemoteDatabaseAdapter,
} from "./database/operations"
import { createPage, extractFrontmatter } from "./notes/text-transformations"
import { DatabaseAdapter, Page } from "./database/types"

import { wikilinkRegex } from "./notes/regexes"
import * as crypto from "crypto"
import { createClient } from "@libsql/client"
import { imageToArrayBuffer } from "./files/images"

const IMAGE_EXTENSIONS = ["png", "webp", "jpg", "jpeg", "gif", "bmp", "svg"]

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
	app: App,
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
	const database = await initializeAdapter(settings, app.vault)

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
		const files = await collectFiles(database, app.vault)

		updateProgress(35, "Collecting notes...")
		console.log("Collecting notes...")
		const notes = await collectNotes(database, app.vault)

		updateProgress(50, "Processing notes...")
		console.log("Processing notes...")
		const pages = await processNotes(
			notes.toProcess,
			notes.outdated,
			files.images.nameToPath,
			this.app
		)

		updateProgress(65, "Syncing files...")
		const fileSync = await syncFiles(
			files.images.toInsert,
			files.images.toDelete,
			database,
			app.vault
		)

		updateProgress(80, "Syncing notes...")
		const pageSync = await syncPages(
			pages.toInsert,
			pages.toDelete,
			fileSync.images.pathsInDb,
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
			await database.export(app.vault)
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
	for (const image of await database.getImageData()) {
		// In theory these should exist, but due to schema changes double checking is good
		if (!image.path || !image.hash) continue
		remoteImageHashes.set(image.path, image.hash)
	}

	// First get all referenced images from markdown files
	const imageRefs = await getImageReferencesInVault(vault)

	// Collect only referenced images that have changed
	const imagesToInsert: {
		file: TFile
		hash: string
		type: "raster" | "svg"
	}[] = []
	const imagesToDelete: Set<string> = new Set()
	const imageNameToPath: Map<string, string> = new Map()
	for (const file of vault.getFiles()) {
		if (IMAGE_EXTENSIONS.includes(file.extension)) {
			imageNameToPath.set(file.name, file.path)
			// Ignore and delete anything that's never mentioned in a markdown file
			if (!imageRefs.has(file.name)) {
				imagesToDelete.add(file.path)
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
		images: {
			toInsert: imagesToInsert,
			toDelete: imagesToDelete,
			nameToPath: imageNameToPath,
		},
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

	// Notes that exist in remote but not in local are outdated and should be deleted
	const remotePaths = new Set(remoteHashes.keys())
	const outdatedNotes = new Set(
		[...remotePaths].filter((x) => !localPaths.has(x))
	)

	console.debug("Notes to process:", notesToProcess)
	console.debug("Outdated notes:", outdatedNotes)

	return {
		toProcess: notesToProcess,
		outdated: outdatedNotes,
	}
}

export interface FileSyncResult {
	images: {
		pathsInDb: string[]
		inserted: number
		deleted: number
	}
}

async function syncFiles(
	imagesToInsert: { file: TFile; hash: string; type: "raster" | "svg" }[],
	imagesToDelete: Set<string>,
	database: DatabaseAdapter,
	vault: Vault
): Promise<FileSyncResult> {
	// Push the media to the database
	console.log(`Deleting unreferenced images...`)
	console.debug("Unreferenced images:", imagesToDelete)
	const deletedImages = await database.deleteImagesByPath([...imagesToDelete])
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

	// Get an updated list of image paths in the database after insertion
	const imagePathsInDb = (await database.getImageData()).map(
		(img) => img.path
	)

	return {
		images: {
			pathsInDb: imagePathsInDb,
			inserted: insertedImagePaths.length,
			deleted: deletedImages,
		},
	}
}

async function processNotes(
	files: { file: TFile; hash: string }[],
	outdatedNotePaths: Set<string>,
	imageNameToPath: Map<string, string>,
	app: App
) {
	// Bind titles to paths
	const routeManager = new RouteManager()
	for (const file of app.vault.getMarkdownFiles()) {
		await routeManager.createRoute(file, app)
	}
	console.debug("Routes", routeManager)
	console.debug("Image name -> Path", imageNameToPath)

	// Process the notes
	const pages: Page[] = []
	const unpublishedNotes: Set<string> = new Set()
	const failedPages: { path: string; error: Error }[] = []
	for (const { file, hash } of files) {
		try {
			const page = await createPage(
				file,
				hash,
				routeManager,
				imageNameToPath,
				app
			)

			if (page) {
				pages.push(page)
			} else {
				unpublishedNotes.add(file.path)
			}
		} catch (error) {
			failedPages.push({ path: file.path, error })
			continue
		}
	}

	if (failedPages.length > 0) {
		new Notice(`${failedPages.length} pages failed to process`)
		console.warn(`${failedPages.length} pages failed to process:`)
		for (const { path, error } of failedPages) {
			console.warn(`- ${path}: ${error.message}`)
		}
	}

	const unpublishedNotesArray = Array.from(unpublishedNotes)
	const outdatedNotePathsArray = Array.from(outdatedNotePaths)
	const toDeleteArray = [...outdatedNotePathsArray, ...unpublishedNotesArray]

	return {
		toInsert: pages,
		toDelete: new Set(toDeleteArray),
	}
}

export interface PageSyncResult {
	insertedNotes: number
	deletedNotes: number
}

async function syncPages(
	pagesToInsert: Page[],
	pagesToDelete: Set<string>,
	imagePathsInDb: string[],
	database: DatabaseAdapter
): Promise<PageSyncResult> {
	// Finally push the notes and media to the database
	console.log(`Deleting outdated notes...`)
	console.debug("Outdated notes:", pagesToDelete)
	const deletedNotes = await database.deleteNotesByPath([...pagesToDelete])
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
			const newRefs = getImageReferencesInString(content)
			refs = new Set([...refs, ...newRefs])
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

		if (extension && IMAGE_EXTENSIONS.includes(extension)) {
			refs.add(filename)
		} else if (extension === "excalidraw") {
			refs.add(filename + ".svg")
		} else if (!extension && match[1] /* is embed */) {
			// Since Excalidraw files are (very annoyingly) just markdown, it's
			// pretty much impossible to reliably distinguish Excalidraw embeds from
			// generic note embeds. As such, we optimistically assume any embed
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
function validateForeignKeys(pages: Page[], imagePathsInDb: string[]) {
	const missingRefs = new Map<string, string[]>()
	for (const page of pages) {
		const issues: string[] = []

		// Check sidebar images for missing references
		for (const img of page.sidebarImages) {
			const imageExists = imagePathsInDb.some(
				(path) => path === img.image_path
			)
			if (!imageExists) {
				issues.push(
					`Sidebar image '${img.image_name}' references missing image '${img.image_path}'`
				)
			}
		}

		if (issues.length > 0) {
			missingRefs.set(page.note.path, issues)
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
		fileSync.images.inserted > 0 ||
		fileSync.images.deleted > 0

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
	if (fileSync.images.inserted > 0) {
		const s = fileSync.images.inserted > 1 ? "s" : ""
		notice += `\n- Updated ${fileSync.images.inserted} image${s}.`
	}
	if (fileSync.images.deleted > 0) {
		const s = fileSync.images.deleted > 1 ? "s" : ""
		notice += `\n- Deleted ${fileSync.images.deleted} outdated image${s}.`
	}

	return { notice, changesMade }
}

/**
 * Like `syncNotes`, except instead of syncing a diff of the entire vault, it forces the
 * sync of the note this command is ran on. Otherwise essentially identical to `syncNotes`.
 * This will also upload any files referenced in this note. It will not delete outdated files
 * and will not trigger a deployment.
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
		const page = await processNotes(
			[{ file: note, hash }],
			new Set(),
			files.images.nameToPath,
			this.app
		)
		const fileSync = await syncFiles(
			files.images.toInsert,
			new Set(),
			database,
			vault
		)
		await syncPages(
			page.toInsert,
			page.toDelete,
			fileSync.images.pathsInDb,
			database
		)

		if (settings.localExport) await database.export(vault)

		let message = ""
		if (page.toDelete.size > 0) {
			message = "Successfully deleted note"
		} else {
			message = "Successfully updated note"
		}
		new Notice(
			`${message}. Use the 'Redeploy website' command to notify the website.`,
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
		if (!IMAGE_EXTENSIONS.includes(file.extension)) continue
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
		images: {
			toInsert: imagesToInsert,
			nameToPath: imageNameToPath,
			existingPaths: existingImagePaths,
		},
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

interface PagePermissions {
	published: boolean
	allowedUsers: string[] | null
}

/**
 * Convert note titles to website routes while avoiding duplicates and
 * disambiguating appropriately. Route format is inspired by Wikipedia,
 * where the route *is* the title, with spaces turned to underscores and
 * disambiguations are added in parenthesis after.
 */
export class RouteManager {
	private titleToRoute: Map<string, string> = new Map()
	private pathToRoute: Map<string, string> = new Map()
	// Keep track of the permissions of each route (published or not, allowed users)
	private routeToPermissions: Map<string, PagePermissions> = new Map()
	// Save all the paths that would point to the same route for disambiguation
	private routeToPaths: Map<string, string[]> = new Map()

	private encodeRoute(title: string) {
		return title.replace(/ /g, "_")
	}

	/**
	 * Create a route for a file path, handling collisions by appending folder names
	 * @param path The full path of the file
	 * @param title The basename of the file
	 * @returns The unique route for this file
	 */
	async createRoute(file: TFile, app: App): Promise<string> {
		const path = file.path
		const title = file.basename
		const frontmatter = await extractFrontmatter(file, app)
		const permissions = {
			allowedUsers: frontmatter["wiki-allowed-users"] ?? null,
			published: frontmatter["wiki-publish"] ?? false,
		}

		// Check if we've already processed this path
		if (this.pathToRoute.has(path)) return this.pathToRoute.get(path)!

		const baseRoute = this.encodeRoute(title)

		// If no path points to this route, just add it to the list
		if (!this.routeToPaths.has(baseRoute)) {
			this.routeToPaths.set(baseRoute, [path])
			this.routeToPermissions.set(baseRoute, permissions)
			this.pathToRoute.set(path, baseRoute)
			this.titleToRoute.set(title, baseRoute)
			this.titleToRoute.set(title.toLowerCase(), baseRoute)
			return baseRoute
		}

		// Otherwise disambiguate and add that
		const fixedRoute = this.disambiguateRoute(baseRoute, path)
		this.routeToPermissions.set(fixedRoute, permissions)
		this.pathToRoute.set(path, fixedRoute)
		this.titleToRoute.set(title, fixedRoute)
		this.titleToRoute.set(title.toLowerCase(), fixedRoute)
		return fixedRoute
	}

	/**
	 * Get the route associated with the given string. Automatically handles
	 * both titles and filepaths.
	 */
	getRoute(titleOrPath: string) {
		if (titleOrPath.includes("/")) {
			return this.pathToRoute.get(titleOrPath)
		} else {
			return this.titleToRoute.get(titleOrPath)
		}
	}

	getPermissions(route: string) {
		return this.routeToPermissions.get(route)
	}

	getRoutes() {
		return this.titleToRoute
	}

	/**
	 * Check if this path and route pair is unique in the given Map.
	 */
	private isRouteUnique(
		path: string,
		route: string,
		existingRoutes: Map<string, string>
	) {
		for (const [otherPath, otherRoute] of existingRoutes) {
			if (path !== otherPath && route === otherRoute) {
				return false
			}
		}
		return true
	}

	/**
	 * Disambiguate a route by appending folder names until it's unique
	 * @param route The base route that has a collision
	 * @param path The path of the file we're creating a route for
	 * @returns A unique route
	 */
	private disambiguateRoute(route: string, path: string): string {
		// Get all paths that currently map to this route and merge them
		const conflictingPaths = this.routeToPaths.get(route) ?? []
		const allPaths = [...conflictingPaths, path]
		this.routeToPaths.set(route, allPaths)

		// Disambiguate shorter paths first since folder order is important
		allPaths.sort((a, b) => a.split("/").length - b.split("/").length)

		// For each path, create a disambiguated route
		const updatedRoutes: Map<string, string> = new Map()
		for (const path of allPaths) {
			const parts = path.split("/").filter((part) => part !== "")

			// Keep adding folders until we have a unique route
			let folderIndex = 0
			let disambiguatedRoute = route
			while (true) {
				const folders = this.encodeRoute(
					parts.slice(0, folderIndex + 1).join("_")
				)
				const newRoute = folders ? `${route}_(${folders})` : route

				// Check if this new route already exists for another path
				let isUnique =
					this.isRouteUnique(path, newRoute, updatedRoutes) &&
					this.isRouteUnique(path, newRoute, this.pathToRoute)

				if (isUnique) {
					disambiguatedRoute = newRoute
					break
				}

				folderIndex += 1
				// Should never happen, but if folders run out, just add a random number
				if (folderIndex >= parts.length) {
					const idk = Math.floor(Math.random() * 100)
					disambiguatedRoute = `${route}_${idk}`
					break
				}
			}

			updatedRoutes.set(path, disambiguatedRoute)
		}

		// Update all the routes
		for (const [path, route] of updatedRoutes) {
			const oldRoute = this.pathToRoute.get(path)!

			this.pathToRoute.set(path, route)
			const pathParts = path.split("/").filter((part) => part !== "")
			const fileName = pathParts[pathParts.length - 1].replace(
				/\.md$/,
				""
			)
			this.titleToRoute.set(fileName, route)
			this.titleToRoute.set(fileName.toLowerCase(), route)

			const permissions = this.routeToPermissions.get(oldRoute)
			if (permissions) {
				this.routeToPermissions.delete(oldRoute)
				this.routeToPermissions.set(route, permissions)
			}
		}

		return updatedRoutes.get(path)!
	}
}
