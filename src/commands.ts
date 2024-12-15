import { Notice, Vault } from "obsidian"
import { convertNotesAndUpload } from "./notes/upload"
import { WikiGeneratorSettings } from "./settings"
import { getPublishableFiles, imageToBase64, partition } from "./utils"
import { globalVault as vault, supabase } from "main"
import { slug } from "github-slugger"
import { Processor, unified } from "unified"
import remarkParse from "remark-parse"
import remarkGfm from "remark-gfm"
import remarkFrontmatter from "remark-frontmatter"
import remarkRehype from "remark-rehype"
import rehypeStringify from "rehype-stringify"
import rehypeStylist from "./unified/rehype-stylist"
import { initializeSqliteClient } from "./database/init"
import { exportDb } from "./database/filesystem"
import remarkFrontmatterExport from "./unified/remark-frontmatter-export"
import rehypeParse from "rehype-parse"
import rehypeWikilinks from "./unified/rehype-wikilinks"
import { ContentChunk, Detail, SidebarImage } from "./notes/types"

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

export async function uploadNotesSqlite(
	vault: Vault,
	settings: WikiGeneratorSettings
) {
	console.log("Uploading notes. This might take a while...")
	new Notice("Uploading notes...")
	const db = await initializeSqliteClient(vault)

	console.log("Uploading media files...")
	const mediaFiles = vault
		.getFiles()
		.filter((file) => file.extension !== "md")

	const imageExtensions = ["png", "webp", "jpg", "jpeg", "gif", "bmp", "svg"]
	const imageBase64: Map<string, string> = new Map()

	for (const file of mediaFiles) {
		if (imageExtensions.includes(file.extension)) {
			const base64 = await imageToBase64(file, vault, true)
			imageBase64.set(file.name, base64)
			// db.run(
			// 	`
			// 	INSERT INTO images (
			// 		image_name,
			// 		image_path,
			// 		base64
			// 	) VALUES (?, ?, ?);
			// `,
			// 	[file.name, slugPath(file.path), base64]
			// )
		} else {
			// Unimplemented file type
		}
	}

	const processor = unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(remarkFrontmatter)
		.use(remarkRehype, { allowDangerousHtml: true })
		.use(rehypeStylist)
		.use(rehypeStringify, { allowDangerousHtml: true })

	const frontmatterProcessor = unified()
		.use(remarkFrontmatter)
		.use(remarkFrontmatterExport)
		.use(rehypeParse)
		.use(rehypeStringify)

	// TODO: Do not permit semicolons in usernames due to lack of SQL arrays in SQLite

	console.log("Converting Markdown to HTML...")
	const titleToPath: Map<string, string> = new Map()
	const files = vault.getMarkdownFiles()
	const pages: Map<
		number,
		{
			note: Note
			chunks: ContentChunk[]
			details: Detail[]
			sidebarImages: SidebarImage[]
		}
	> = new Map()

	for (const [noteId, file] of files.entries()) {
		const _slug = slugPath(file.path)
		const title = file.name.replace(".md", "")
		const path = file.path.replace(".md", "")

		const content = await vault.read(file)
		const fmVfile = await frontmatterProcessor.process(content)
		const frontmatter = fmVfile.data.matter as Frontmatter
		if (!frontmatter["wiki-publish"]) {
			continue
		}

		const { md, details, sidebarImages } = await replaceCustomBlocks(
			content,
			file.name,
			processor,
			imageBase64
		)
		const chunks = chunkMd(md, frontmatter["wiki-allowed-users"] ?? [])
		chunks.forEach(async (chunk) => {
			const vfile = await processor.process(chunk.text)
			chunk.text = String(vfile)
		})

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

	const postprocessor = unified()
		.use(rehypeParse, { fragment: true })
		.use(rehypeWikilinks, titleToPath, imageBase64)
		.use(rehypeStringify, { allowDangerousHtml: true })

	console.log("Converting wikilinks...")
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

	console.log("Exporting database...")
	await exportDb(db, vault)
	new Notice("Finshed exporting database!")

	console.log("Closing database...")
	db.close()
}

export function slugPath(path: string): string {
	return path
		.replace(".md", "")
		.split("/")
		.map((s) => slug(s))
		.join("/")
}

/**
 * Parses the given markdown text, removes all :::blocks::: and returns the related data structures.
 * This function ignores the :::secret::: blocks. Use the `chunkMd` function to split the page by those.
 * @param md The markdown text to transform
 * @param filename The name of the file that's being processed
 * @param processor A unified processor to convert Markdown into HTML
 * @param imageBase64 A map that links image filenames to their base64 representation
 * @returns The modified text, alongside all other additional data from custom blocks
 */
async function replaceCustomBlocks(
	md: string,
	filename: string,
	processor: Processor<any, any, any, any, any>,
	imageBase64: Map<string, string>
) {
	// Remove :::hidden::: blocks
	md = md.replace(/^:::hidden\n.*?\n:::/gms, "")

	// Find and parse the first :::details::: block
	const detailsRegex = /^:::details\n(.*?)\n:::/ms
	const detailsMatch = md.match(detailsRegex)
	let details: Detail[] = []
	if (detailsMatch) {
		details = await parseDetails(detailsMatch[1], filename, processor)
		if (details.length === 0) {
			new Notice(`Improperly formatted :::details::: in ${filename}`)
			console.warn(`Improperly formatted :::details::: in ${filename}`)
		}
		md = md.replace(detailsRegex, "")
	}

	// Find and parse all :::image::: blocks, uploading all new images
	const imageRegex = /^:::image(\(fullres\))?\n(.*?)\n:::/gms
	const imageMatch = Array.from(md.matchAll(imageRegex))
	const sidebarImages: SidebarImage[] = []
	for (const i in imageMatch) {
		const index = parseInt(i)
		const match = imageMatch[index]
		const img = await parseImage(
			match[2],
			index + 1,
			filename,
			processor,
			imageBase64
		)
		if (img) sidebarImages.push(img)
		md = md.replace(match[0], "")
	}

	return { md, details, sidebarImages }
}

async function parseDetails(
	match: string,
	filename: string,
	processor: Processor
): Promise<Detail[]> {
	const detailsList: Detail[] = []
	const details = match.split("\n").filter((line) => line !== "")

	for (const i in details) {
		const index = parseInt(i)
		const detail = details[i]

		if (detail === "") continue

		const split = detail.split(/:\s*/)
		if (split.length === 0) {
			new Notice(`Improperly formatted :::details::: in ${filename}`)
			console.warn(`Improperly formatted :::details::: in ${filename}`)
			return [{ order: 1, key: "", value: "" }]
		}
		if (split.length === 1) {
			// Key without a value
			const key = (await processor.process(split[0])).toString()
			detailsList.push({
				order: index + 1,
				key,
				value: undefined,
			})
		} else {
			// Both key and value
			const key = (await processor.process(split[0])).toString()
			const preValue = split.splice(1).reduce((a, b) => a + ": " + b)
			const value = (await processor.process(preValue)).toString()
			detailsList.push({
				order: index + 1,
				key,
				value,
			})
		}
	}

	return detailsList
}

async function parseImage(
	blockContents: string,
	order: number,
	currFile: string,
	processor: Processor,
	imageBase64: Map<string, string>
): Promise<SidebarImage | undefined> {
	// Parse markdown for filename and captions
	// Unlike wikilinks, there's no need to check for user-defined dimensions
	const lines = blockContents.split("\n").filter((line) => line !== "")
	if (lines.length === 0) {
		console.warn(`Error parsing :::image::: block in ${currFile}.`)
		new Notice(`Error parsing :::image::: block in ${currFile}.`)
		return undefined
	}

	// Grab the filename from the wikilink
	const wikilink = lines[0].match(/!\[\[(.*?)(\|.*)?\]\]/)
	let imageFile: string
	if (wikilink) {
		imageFile = wikilink[1]
	} else {
		console.warn(
			`Could not read filename in :::image::: block in ${currFile}.`
		)
		new Notice(
			`Could not read filename in :::image::: block in ${currFile}.`
		)
		return undefined
	}

	// Then the caption, if present
	let caption: string | undefined
	if (lines.length > 1) {
		caption = lines.splice(1).join("\n")
		caption = (await processor.process(caption)).toString()
	}

	const base64 = imageBase64.get(imageFile)
	if (!base64) {
		return undefined
	}

	return {
		order,
		image_name: imageFile,
		base64,
		caption: caption,
	}
}

/**
 * Splits markdown into chunks with metadata attached to them. Primarily, this allows each
 * chunk to have a different authorization level so that it's possible to hide only certain
 * parts of a page instead of just the whole page.
 * @param md The text to split
 * @returns An array of chunks with metadata
 */
function chunkMd(md: string, allowedUsers: string[]): ContentChunk[] {
	const secretChunks = Array.from(
		md.matchAll(/^:::secret\s*\((.*?)\)\n(.*?)\n:::/gms)
	)
	if (secretChunks.length === 0)
		return [{ chunk_id: 1, text: md, allowed_users: allowedUsers }]

	// Unwrap the tags and keep only the inner content
	md = md.replace(/^:::secret\s*\((.*?)\)\n(.*?)\n:::/gms, "$2")

	let currChunkId = 1
	const chunks: ContentChunk[] = []

	for (const match of secretChunks) {
		let currText: string
		const users = match[1].split(",").map((s) => s.trim())

		if (chunks.length > 0) {
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			currText = chunks.pop()!.text
			currChunkId -= 1
		} else {
			currText = md
		}

		const parts = partition(currText, match[2])
		for (const i in parts) {
			chunks.push({
				chunk_id: currChunkId,
				text: parts[i],
				allowed_users: parseInt(i) % 2 !== 0 ? users : allowedUsers,
				// The way `partition` works puts all secret chunks on odd indexes
			})
			currChunkId += 1
		}
	}

	return chunks
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
