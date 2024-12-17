import { Notice, Vault } from "obsidian"
import { WikiGeneratorSettings } from "./settings"
import { getPublishableFiles, imageToBase64 } from "./utils"
import { unified } from "unified"
import { initializeSqliteClient } from "./database/init"
import { pushDatabaseToWebsite } from "./repository"
import { exportDb } from "./database/filesystem"
import { makePagesFromFiles } from "./notes/text-transformations"
import { getUsers } from "./database/requests"
import { convertWikilinksAndInsert, insertUsers } from "./database/operations"

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
	console.log("Uploading notes...")
	new Notice("Uploading notes. This might take a while...")
	const db = await initializeSqliteClient(vault)

	// First handle the non-markdown files (currently only images)
	console.log("Uploading media files...")
	const mediaFiles = vault
		.getFiles()
		.filter((file) => file.extension !== "md")

	const imageExtensions = ["png", "webp", "jpg", "jpeg", "gif", "bmp", "svg"]
	const imageBase64: Map<string, string> = new Map()

	for (const file of mediaFiles) {
		if (imageExtensions.includes(file.extension)) {
			// Images are converted to base64 and stored to later be embedded in the HTML
			const base64 = await imageToBase64(file, vault, true)
			imageBase64.set(file.name, base64)
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
		imageBase64,
		vault
	)

	// Initialize one last processor to handle wikilink conversion
	const postprocessor = unified()
		.use(rehypeParse, { fragment: true })
		.use(rehypeWikilinks, titleToPath, imageBase64)
		.use(rehypeStringify, { allowDangerousHtml: true })

	console.log("Converting wikilinks and inserting into database...")
	//@ts-ignore
	await convertWikilinksAndInsert(db, pages, settings, postprocessor)

	// Fetch user accounts from the website and insert them into the database
	// to avoid deleting user accounts every time
	console.log("Getting user accounts from website...")
	const users = await getUsers(settings)
	insertUsers(users, db)

	// Finally save the database either locally or in the website repository
	console.log("Exporting database...")
	if (settings.localExport) {
		await exportDb(db, vault)
		new Notice("Database exported to plugin folder!")
	} else {
		await pushDatabaseToWebsite(
			db,
			settings.githubRepoToken,
			settings.githubUsername,
			settings.githubRepoName
		)
		new Notice("Database pushed to GitHub repository!")
	}

	// Close the database to avoid leaking memory
	console.log("Closing database...")
	db.close()

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
			const propsRegex = /^---\n+(.*?)\n+---/s
			// Isolate properties
			const props = noteText.match(propsRegex)
			if (props) {
				// Check if a publish property is already there
				const publish = props[1].match(
					/(wiki)|(dg)-publish: (true)|(false)/
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
	const regex = RegExp(`^---\n(.*?)wiki-publish: ${value}(.*?)\n---\n`, "s")
	for (const note of notes) {
		vault.process(note, (noteText) => {
			return noteText.replace(regex, `---\n$1$2-publish: ${value}$3\n---`)
		})
	}
}
