import { Notice, TFile, Vault } from "obsidian"
import { WikiGeneratorSettings } from "./settings"
import { getPublishableFiles, imageToArrayBuffer } from "./utils"
import { unified } from "unified"
import { createLocalDatabase } from "./database/init"
import {
	getUsersFromRemote,
	LocalDatabaseAdapter,
	RemoteDatabaseAdapter,
} from "./database/operations"
import {
	convertWikilinks,
	makePagesFromFiles,
} from "./notes/text-transformations"
import { DatabaseAdapter } from "./database/types"

import remarkParse from "remark-parse"
import remarkGfm from "remark-gfm"
import remarkFrontmatter from "remark-frontmatter"
import remarkRehype from "remark-rehype"
import remarkMath from "remark-math"
import remarkFrontmatterExport from "./unified/remark-frontmatter-export"

import rehypeStylist from "./unified/rehype-stylist"
import rehypeParse from "rehype-parse"
import rehypeWikilinks from "./unified/rehype-wikilinks"
import rehypeCallouts from "rehype-callouts"
import rehypePrism from "rehype-prism-plus"
import rehypeKatex from "rehype-katex"
import rehypeMermaid from "rehype-mermaid"
import rehypeSlug from "rehype-slug"
import rehypeStringify from "rehype-stringify"
import { propsRegex, wikilinkRegex } from "./notes/regexes"
import * as crypto from "crypto"
import { createClient } from "@libsql/client"

const imageExtensions = ["png", "webp", "jpg", "jpeg", "gif", "bmp", "svg"]

/**
 * The main function of the plugin. Convert every publishable Markdown note in the vault
 * into HTML, convert images to webp and possibly compress them, save them in a SQLite
 * database and upload it to the website repository (unless the local export setting is true).
 * @param vault A reference to the vault
 * @param settings The plugin settings
 */
export async function uploadNotes(
	vault: Vault,
	settings: WikiGeneratorSettings,
	reset = false
) {
	// Make sure we got everything we need
	if (!settings.localExport && settings.deployHook.length === 0) {
		throw new Error(
			"Deploy hook is not set. Please create one before uploading."
		)
	}

	console.log("-".repeat(10), "[WIKI GENERATOR UPLOAD START]", "-".repeat(10))
	console.log("Uploading notes...")
	new Notice("Uploading notes. This might take a while...")

	// Initialize common database interface
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

	if (reset) {
		console.log("Dropping all content tables...")
		new Notice("Clearing existing notes and media...")
		await adapter.clearContent()
	}

	console.log("Running migrations...")
	await adapter.runMigrations()

	// Process media files
	console.log("Processing media files...")

	// Get all images in the database
	const existingImageHashes = new Map<string, string>()
	for (const image of await adapter.getImageData()) {
		// In theory these should exist, but due to schema changes double checking is good
		if (!image.path || !image.hash) continue
		existingImageHashes.set(image.path, image.hash)
	}

	// First get all referenced images from markdown files
	const imageRefs = await getReferencedImages(vault)

	// Collect only referenced images that have changed
	const images: { file: TFile; hash: string; type: "raster" | "svg" }[] = []
	for (const file of vault.getFiles()) {
		if (imageExtensions.includes(file.extension)) {
			// Ignore anything that's never mentioned in a markdown file
			if (!imageRefs.has(file.name)) continue
			// Calculate the hash to ignore images that have not changed since last upload
			const buf = await vault.readBinary(file)
			const hash = crypto
				.createHash("sha256")
				.update(new Uint8Array(buf))
				.digest("hex")
			const type = file.extension === "svg" ? "svg" : "raster"

			const maybeExistingHash = existingImageHashes.get(file.path)
			if (!maybeExistingHash || hash !== maybeExistingHash) {
				// If the file doesn't exist or it changed, insert/overwrite it
				images.push({ file, hash, type })
			} else {
				// If it exists and it's identical to last time, don't bother reprocessing it
				existingImageHashes.delete(file.path)
			}
		} else {
			// Unsupported filetypes are skipped
			continue
		}
	}
	// Anything left needs to be deleted since it's old and needs to be overwritten
	const imageHashesToDelete: string[] = [...existingImageHashes.values()]

	// Create a map between image filenames and their path
	const imageNameToPath: Map<string, string> = new Map()
	for (const file of vault.getFiles()) {
		if (!imageExtensions.includes(file.extension)) continue
		imageNameToPath.set(file.name, file.path)
	}

	// Push the media to the database
	console.log(`Deleting ${imageHashesToDelete.length} outdated images...`)
	await adapter.deleteImagesByHashes(imageHashesToDelete)

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
	const uploadedImages = imagesToInsert.length
	console.log(`Inserting ${uploadedImages} images...`)
	await adapter.insertImages(imagesToInsert)

	// Initialize two unified processors to handle syntax conversion and frontmatter export
	const processor = unified()
		.use(remarkParse) // Parse markdown into a syntax tree
		.use(remarkMath) // Parse $inline$ and $$display$$ math blocks
		.use(remarkGfm, { singleTilde: false }) // Parse Github-flavored markdown
		.use(remarkFrontmatter) // Expose frontmatter in the syntax tree
		.use(remarkRehype, { allowDangerousHtml: true }) // Convert to an HTML syntax tree
		.use(rehypeSlug) // Add ids to headers
		.use(rehypeCallouts) // Handle Obsidian-style callouts
		.use(rehypeStylist) // Add classes to tags that are unstyled in Tailwind
		.use(rehypePrism, { ignoreMissing: true }) // Highlight code blocks
		.use(rehypeKatex) // Render LaTeX math with KaTeX
		.use(rehypeMermaid, { strategy: "img-svg", dark: true }) // Render Mermaid diagrams
		.use(rehypeStringify, { allowDangerousHtml: true }) // Compile syntax tree into an HTML string

	const frontmatterProcessor = unified()
		.use(remarkFrontmatter)
		.use(remarkFrontmatterExport) // Export the frontmatter into an array
		.use(rehypeParse)
		.use(rehypeStringify)

	// Fetch all markdown files and filter out ones that are unchanged since the last upload
	console.log("Converting Markdown to HTML...")
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
		} else {
			// If it exists and it's identical to last time, don't bother reprocessing it
			existingHashes.delete(file.path)
		}
	}
	// What's left is what needs to be deleted
	const hashesToDelete: string[] = [...existingHashes.values()]

	// Convert them into rich data structures
	const { pages, titleToPath } = await makePagesFromFiles(
		files,
		//@ts-ignore
		processor,
		frontmatterProcessor,
		imageNameToPath,
		vault
	)
	const uploadedNotes = pages.size

	// Initialize one last processor to handle wikilink conversion
	const postprocessor = unified()
		.use(rehypeParse, { fragment: true })
		.use(rehypeWikilinks, titleToPath, imageNameToPath)
		.use(rehypeStringify, { allowDangerousHtml: true })

	console.log("Converting wikilinks...")
	//@ts-ignore
	const pagesWithLinks = await convertWikilinks(pages, postprocessor)

	// Fetch user accounts from the website and insert them into the database
	// to avoid deleting user accounts every time
	if (settings.localExport && !settings.ignoreUsers) {
		console.log("Cloning user accounts from Turso...")
		const users = await getUsersFromRemote(settings.dbUrl, settings.dbToken)
		await adapter.insertUsers(users)
	}

	// Finally push the notes and media to the database
	console.log(`Deleting ${hashesToDelete.length} outdated notes`)
	await adapter.deleteNotesByHashes(hashesToDelete)
	console.log(`Inserting ${uploadedNotes} notes...`)
	await adapter.pushPages(pagesWithLinks, settings)

	if (settings.localExport) {
		console.log("Exporting database...")
		await adapter.export(vault)
		new Notice(
			`Database exported to plugin folder! Pushed ${uploadedNotes} notes and ${uploadedImages} images.`
		)
	} else {
		new Notice(
			`Uploaded ${uploadedNotes} notes and ${uploadedImages} images.`
		)
	}

	// Cleanup
	await adapter.close()

	// Ping Vercel so it rebuilds the site
	// if (!settings.localExport) {
	// 	console.log("Sending POST request to deploy hook")
	// 	request({ url: settings.deployHook, method: "POST" })
	// }

	console.log(`Successfully uploaded ${uploadedNotes} notes`)
	console.log("-".repeat(10), "[WIKI GENERATOR UPLOAD END]", "-".repeat(10))
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
	for (const note of notes) {
		vault.process(note, (noteText) => {
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
	}
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
				if (!extension) continue

				if (imageExtensions.includes(extension)) {
					refs.add(filename)
				} else if (
					extension === "excalidraw" ||
					content.includes("excalidraw-plugin:")
				) {
					// Excalidraw files should reference the auto-exported SVGs
					refs.add(filename + ".svg")
				}
			}
		} catch (error) {
			console.error(`Error reading ${file.path}:`, error)
		}
	}
	return refs
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
