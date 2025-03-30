import { Notice, request, Vault } from "obsidian"
import { WikiGeneratorSettings } from "./settings"
import { getPublishableFiles, imageToArrayBuffer } from "./utils"
import { unified } from "unified"
import {
	initializeLocalDatabase,
	initializeRemoteDatabase,
} from "./database/init"
import { exportDb } from "./database/filesystem"
import {
	convertWikilinks,
	makePagesFromFiles,
} from "./notes/text-transformations"
import { getUsers } from "./database/requests"
import {
	clearRemoteDatabase,
	insertImageLocal,
	insertImageRemote,
	insertUsers,
	pushPagesToLocal,
	pushPagesToRemote,
	resetRemoteMedia,
	runRemoteMigrations,
} from "./database/operations"

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
import { Database } from "sql.js"
import { Client } from "@libsql/client"
import { propsRegex } from "./notes/regexes"

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
	if (settings.deployHook.length === 0) {
		throw new Error(
			"Deploy hook is not set. Please create one before uploading."
		)
	}

	console.log("Uploading notes...")
	new Notice("Uploading notes. This might take a while...")

	let db: Database | Client
	if (settings.localExport) {
		db = await initializeLocalDatabase(vault)
	} else {
		db = await initializeRemoteDatabase(settings.dbUrl, settings.dbToken)
	}

	// First handle the non-markdown files (currently only images)
	console.log("Processing media files...")
	const mediaFiles = vault
		.getFiles()
		.filter((file) => file.extension !== "md")

	const imageExtensions = ["png", "webp", "jpg", "jpeg", "gif", "bmp", "svg"]
	const imageNameToId: Map<string, number> = new Map()

	if (!settings.localExport) {
		resetRemoteMedia(db as Client)
	}
	for (const file of mediaFiles) {
		if (imageExtensions.includes(file.extension)) {
			const buf = await imageToArrayBuffer(file, vault, true)
			const imageId = settings.localExport
				? insertImageLocal(file.name, buf, db as Database)
				: await insertImageRemote(file.name, buf, db as Client)

			imageNameToId.set(file.name, imageId)
		} else {
			// Unimplemented file type
		}
	}

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

	// Take all markdown files and convert them into rich data structures
	console.log("Converting Markdown to HTML...")
	const files = vault.getMarkdownFiles()

	const { pages, titleToPath } = await makePagesFromFiles(
		files,
		//@ts-ignore
		processor,
		frontmatterProcessor,
		imageNameToId,
		vault
	)

	// Initialize one last processor to handle wikilink conversion
	const postprocessor = unified()
		.use(rehypeParse, { fragment: true })
		.use(rehypeWikilinks, titleToPath, imageNameToId)
		.use(rehypeStringify, { allowDangerousHtml: true })

	console.log("Converting wikilinks...")
	//@ts-ignore
	const pagesWithLinks = await convertWikilinks(pages, postprocessor)

	// Fetch user accounts from the website and insert them into the database
	// to avoid deleting user accounts every time
	if (settings.localExport && !settings.ignoreUsers) {
		console.log("Cloning user accounts from Turso...")
		const users = await getUsers(settings)
		//@ts-ignore
		insertUsers(users, db as Database)
	}

	// Finally either save the database locally or insert into Turso
	if (settings.localExport) {
		console.log("Exporting database...")
		pushPagesToLocal(db as Database, pagesWithLinks, settings)
		await exportDb(db as Database, vault)
		new Notice("Database exported to plugin folder!")
	} else {
		// If we are working with Turso, clear existing content before uploading
		console.log("Clearing existing notes...")
		await clearRemoteDatabase(db as Client)
		console.log("Setting up tables...")
		await runRemoteMigrations(db as Client)
		console.log("Inserting notes...")
		await pushPagesToRemote(db as Client, pagesWithLinks, settings)
		new Notice("Notes pushed to database!")
	}

	// Close the database or Turso connection to avoid leaking memory
	console.log("Closing database...")
	db.close()

	console.log("Sending POST request to deploy hook")
	request({
		url: settings.deployHook,
		method: "POST",
	})

	console.log("Successfully uploaded notes")
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
