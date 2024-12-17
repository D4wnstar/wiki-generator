import { Notice, TFile, Vault } from "obsidian"
import { convertNotesAndUpload } from "./notes/upload"
import { WikiGeneratorSettings } from "./settings"
import { getPublishableFiles, imageToBase64, slugPath } from "./utils"
import { globalVault as vault, supabase } from "main"
import { Processor, unified } from "unified"
import remarkParse from "remark-parse"
import remarkGfm from "remark-gfm"
import remarkFrontmatter from "remark-frontmatter"
import remarkRehype from "remark-rehype"
import rehypeStringify from "rehype-stringify"
import rehypeStylist from "./unified/rehype-stylist"
import { initializeSqliteClient } from "./database/init"
import remarkFrontmatterExport from "./unified/remark-frontmatter-export"
import rehypeParse from "rehype-parse"
import rehypeWikilinks from "./unified/rehype-wikilinks"
import { ContentChunk, Detail, SidebarImage } from "./notes/types"
import { pushDatabaseToWebsite } from "./repository"
import { exportDb } from "./database/filesystem"
import { Database } from "sql.js"
import type { Root } from "hast"
import { chunkMd, replaceCustomBlocks } from "./notes/custom-blocks"
import { removeCodeblocks, addCodeblocksBack } from "./notes/format"
import remarkMath from "remark-math"
import rehypeCallouts from "rehype-callouts"
import rehypePrism from "rehype-prism-plus"
import rehypeKatex from "rehype-katex"
import rehypeMermaid from "rehype-mermaid"
import rehypeSlug from "rehype-slug"

type Frontmatter = {
	"wiki-publish": boolean | undefined
	"wiki-title": string | undefined
	"wiki-home": string | undefined
	"wiki-allowed-users": string[] | undefined
}

type Note = {
	title: string
	alt_title: string | null
	path: string
	slug: string
	frontpage: string | number
	allowed_users: string | null
}

type Pages = Map<
	number,
	{
		note: Note
		chunks: ContentChunk[]
		details: Detail[]
		sidebarImages: SidebarImage[]
	}
>

export async function uploadNotesSqlite(
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
		.use(rehypeMermaid, { strategy: "img-png", dark: true }) // Render Mermaid diagrams
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
		imageBase64
	)

	// Initialize one last processor to handle wikilink conversion
	const postprocessor = unified()
		.use(rehypeParse, { fragment: true })
		.use(rehypeWikilinks, titleToPath, imageBase64)
		.use(rehypeStringify, { allowDangerousHtml: true })

	console.log("Converting wikilinks and inserting into database......")
	await convertWikilinksAndInsert(db, pages, settings, postprocessor)

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
}

/**
 * Convert Markdown files into rich data structures encoding their contents.
 * @param files A list of Markdown files
 * @param processor A unified processor to convert Markdown into HTML
 * @param frontmatterProcessor A unified process to extract markdown frontmatter
 * @param imageBase64 A Map linking image filenames with their base64 representation
 * @returns A Pages object containing all converted data and a Map linking lowercase
 * page titles with their full filepath slugs.
 */
async function makePagesFromFiles(
	files: TFile[],
	processor: Processor<Root, Root, Root, Root, string>,
	frontmatterProcessor: Processor<Root, undefined, undefined, Root, string>,
	imageBase64: Map<string, string>
): Promise<{ pages: Pages; titleToPath: Map<string, string> }> {
	const pages: Pages = new Map()
	const titleToPath: Map<string, string> = new Map()

	for (const [noteId, file] of files.entries()) {
		const _slug = slugPath(file.path)
		const title = file.name.replace(".md", "")
		const path = file.path.replace(".md", "")
		const content = await vault.read(file)

		// Grab the frontmatter first because we need some properties
		const fmVfile = await frontmatterProcessor.process(content)
		const frontmatter = fmVfile.data.matter as Frontmatter

		// Skip pages that shouldn't be published
		if (!frontmatter["wiki-publish"]) {
			continue
		}

		// Parse and replace custom :::blocks::: and delete Obsidian comments
		// Codeblocks are removed and added back later to keep them unmodified
		const { md: strippedMd, codeBlocks } = removeCodeblocks(content)
		const strippedMd2 = strippedMd.replace(/%%.*?%%/gs, "")
		const {
			md: strippedMd3,
			details,
			sidebarImages,
		} = await replaceCustomBlocks(
			strippedMd2,
			file.name,
			processor,
			imageBase64
		)
		const md = addCodeblocksBack(strippedMd3, codeBlocks)
			.replace(/^\$\$/gm, "$$$$\n") // remarkMath needs newlines to consider a math block as display
			.replace(/\$\$$/gm, "\n$$$$") // The quadruple $ is because $ is the backreference character in regexes and is escaped as $$, so $$$$ -> $$

		// Split the page into chunks based on permissions
		const chunks = chunkMd(md, frontmatter["wiki-allowed-users"] ?? [])

		// Convert the markdown of each chunk separately
		chunks.forEach(async (chunk) => {
			const vfile = await processor.process(chunk.text)
			chunk.text = String(vfile)
		})

		// Save the current title/slug pair for later use
		titleToPath.set(title.toLowerCase(), _slug)

		const note = {
			title,
			alt_title: frontmatter["wiki-title"] ?? null,
			path,
			slug: _slug,
			frontpage: frontmatter["wiki-home"] ?? 0,
			allowed_users:
				frontmatter["wiki-allowed-users"]?.join("; ") ?? null,
		}
		pages.set(noteId + 1, { note, chunks, details, sidebarImages })
	}

	return { pages, titleToPath }
}

async function convertWikilinksAndInsert(
	db: Database,
	pages: Pages,
	settings: WikiGeneratorSettings,
	postprocessor: Processor<Root, undefined, undefined, Root, string>
) {
	for (const [noteId, page] of pages.entries()) {
		db.run(
			`
			INSERT INTO notes (
				id,
				title,
				alt_title,
				path,
				slug,
				frontpage,
				allowed_users
			) VALUES (?, ?, ?, ?, ?, ?, ?);
		`,
			[
				noteId,
				page.note.title,
				page.note.alt_title,
				page.note.path,
				page.note.slug,
				page.note.frontpage,
				page.note.allowed_users,
			]
		)

		for (const chunk of page.chunks) {
			const vfile = await postprocessor.process(chunk.text)
			const text = String(vfile)
			const allowed_users =
				chunk.allowed_users.length > 0
					? chunk.allowed_users.join(";")
					: null
			db.run(
				`
				INSERT INTO note_contents (
					note_id,
					chunk_id,
					"text",
					allowed_users
				) VALUES (?, ?, ?, ?);
			`,
				[noteId, chunk.chunk_id, text, allowed_users]
			)
		}

		for (const detail of page.details) {
			const vfile = detail.value
				? await postprocessor.process(detail.value)
				: undefined
			const content = vfile ? String(vfile) : null
			db.run(
				`
				INSERT INTO details (
					note_id,
					"order",
					detail_name,
					detail_content
				) VALUES (?, ?, ?, ?);
			`,
				[noteId, detail.order, detail.key, content]
			)
		}

		for (const img of page.sidebarImages) {
			const vfile = img.caption
				? await postprocessor.process(img.caption)
				: undefined
			const caption = vfile ? String(vfile) : null
			db.run(
				`
				INSERT INTO sidebar_images (
					note_id,
					"order",
					image_name,
					base64,
					caption
				) VALUES (?, ?, ?, ?, ?);
			`,
				[noteId, img.order, img.image_name, img.base64, caption]
			)
		}
	}

	db.run(
		`
		INSERT INTO wiki_settings (
			title,
			allow_logins
		) VALUES (?, ?);
	`,
		[settings.wikiTitle, settings.allowLogins ? 1 : 0]
	)
}

export async function uploadNotes(settings: WikiGeneratorSettings) {
	if (!supabase) {
		console.error(
			"The Supabase client has not been initialized properly. Please check the URL and Service Key and reconnect."
		)
		new Notice(
			"Cannot connect to Supabase. Please check the URL and Service Key and reconnect."
		)
		return
	}

	// Reset wiki settings
	const { error: deletionError } = await supabase
		.from("wiki_settings")
		.delete()
		.gte("id", 0)

	// Insert the new settings
	const { error: settingsError } = await supabase
		.from("wiki_settings")
		.insert({
			settings: {
				title: settings.wikiTitle,
				allowLogins: settings.allowLogins,
			},
		})

	if (deletionError || settingsError) {
		new Notice("Something went wrong when updating wiki settings.")
		if (deletionError) console.error(deletionError)
		if (settingsError) console.error(settingsError)
		return
	}

	console.log("Uploading notes...")
	new Notice("Uploading notes...")
	try {
		await convertNotesAndUpload()
	} catch (error) {
		new Notice(error.message)
		console.error(`Uncaught error: ${error.message}`)
	}

	console.log("Successfully uploaded notes!")
	new Notice("Finshed uploading notes!")
}

export function massAddPublish(settings: WikiGeneratorSettings) {
	const notes = getPublishableFiles(settings)
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
				// Otherwise add a new property, defaulting to true
				noteText = noteText.replace(
					propsRegex,
					`---\nwiki-publish: true\n$1\n---`
				)
			} else {
				// If there are no properties, prepend a new publish one
				noteText = `---\nwiki-publish: true\n---\n` + noteText
			}

			return noteText
		})
	}
}

export function massSetPublishState(
	settings: WikiGeneratorSettings,
	state: boolean
) {
	const notes = getPublishableFiles(settings)
	const regex = RegExp(`^---\n(.*?)wiki-publish: ${state}(.*?)\n---\n`, "s")
	for (const note of notes) {
		vault.process(note, (noteText) => {
			return noteText.replace(regex, `---\n$1$2-publish: ${state}$3\n---`)
		})
	}
}
