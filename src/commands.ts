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
import { propsRegex } from "./notes/regexes"
import * as crypto from "crypto"
import { createClient } from "@libsql/client"

/**
 * The main function of the plugin. Convert every publishable Markdown note in the vault
 * into HTML, convert images to webp and possibly compress them, save them in a SQLite
 * database and upload it to the website repository (unless the local export setting is true).
 * @param vault A reference to the vault
 * @param settings The plugin settings
 */
export async function uploadNotes(
	vault: Vault,
	settings: WikiGeneratorSettings
) {
	// Make sure we got everything we need
	if (!settings.localExport && settings.deployHook.length === 0) {
		throw new Error(
			"Deploy hook is not set. Please create one before uploading."
		)
	}

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

	console.log("Running migrations...")
	await adapter.runMigrations()

	// Process media files
	console.log("Processing media files...")

	let images: { file: TFile; hash: string }[] = []
	const imageExtensions = ["png", "webp", "jpg", "jpeg", "gif", "bmp"]
	const existingImageHashes = new Map<string, string>()
	for (const image of await adapter.getImageData()) {
		// In theory these should exist, but due to schema changes double chekcing is good
		if (!image.path || !image.hash) continue
		existingImageHashes.set(image.path, image.hash)
	}

	// Divide media by file type
	for (const file of vault.getFiles()) {
		if (file.extension === "md") continue

		// Images
		if (imageExtensions.includes(file.extension)) {
			const buf = await vault.readBinary(file)
			const hash = crypto
				.createHash("sha256")
				.update(new Uint8Array(buf))
				.digest("hex")
			images.push({ file, hash })
		} else {
			// Not an image - currently unsupported
		}
	}

	// Filter out media that's unchanged since the last upload
	images = images.filter(({ file, hash }) => {
		const maybeExistingHash = existingImageHashes.get(file.path)
		if (!maybeExistingHash || hash !== maybeExistingHash) {
			// If the file doesn't exist or it's stale, insert/overwrite it
			return true
		} else {
			// If it exists and it's fresh, leave it alone
			existingImageHashes.delete(file.path)
			return false
		}
	})
	// What's left is what needs to be deleted
	const imageHashesToDelete: string[] = [...existingImageHashes.values()]

	const imageNameToPath: Map<string, string> = new Map()
	for (const image of images) {
		imageNameToPath.set(image.file.name, image.file.path)
	}

	// Push the media to the database
	console.log(`Deleting ${imageHashesToDelete.length} outdated images...`)
	await adapter.deleteImagesByHashes(imageHashesToDelete)
	const imagesToInsert = await Promise.all(
		images.map(async ({ file, hash }) => {
			return {
				path: file.path.replace(/\.md$/, ""),
				alt: file.name,
				hash,
				buf: await imageToArrayBuffer(file, vault, true),
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

	let files = await Promise.all(
		vault.getMarkdownFiles().map(async (file) => {
			const buf = await vault.readBinary(file)
			const hash = crypto
				.createHash("sha256")
				.update(new Uint8Array(buf))
				.digest("hex")
			return { file, hash }
		})
	)
	files = files.filter(({ file, hash }) => {
		const maybeExistingHash = existingHashes.get(file.path)
		if (!maybeExistingHash || hash !== maybeExistingHash) {
			// If the note doesn't exist or it's stale, insert/overwrite it
			return true
		} else {
			// If it exists and it's fresh, leave it alone
			existingHashes.delete(file.path)
			return false
		}
	})
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
		adapter.insertUsers(users)
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
