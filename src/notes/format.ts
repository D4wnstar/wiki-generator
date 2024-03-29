import { Notice, TFile } from "obsidian"
import { uploadImage } from "./wikilinks"
import * as MarkdownIt from "markdown-it"
import hljs from "highlight.js"
import { calloutIcons, partition, slugifyPath } from "../utils"
import { NoteProperties, SidebarImage, Note, ContentChunk, Detail } from "./types"
import { globalVault } from "main"

export async function vaultToNotes(
	converter: MarkdownIt
): Promise<[Note[], TFile[]]> {
	const notes: Note[] = []
	// Get the non-markdown media first
	let files = globalVault.getFiles()
	const media = files.filter((file) => file.extension !== "md")

	// Then go through the markdown notes
	files = globalVault.getMarkdownFiles()
	for (const file of files) {
		const slug = slugifyPath(file.path.replace(".md", ""))

		const content = await globalVault.read(file)
		const formatted = await formatMd(content, file.name, media, converter)

		for (const i in formatted.chunks) {
			// Replace the markdown with the HTML
			const html = converter.render(formatted.chunks[i].text)
			formatted.chunks[i].text = fixHtml(html)
		}
 
		const leadHtml = converter.render(formatted.lead)
		formatted.lead = fixHtml(leadHtml)

		notes.push({
			title: file.name.replace(".md", ""),
			path: file.path.replace(".md", ""),
			slug: slug,
			content: formatted.chunks,
			lead: formatted.lead,
			references: new Set<string>(),
			backreferences: [],
			properties: formatted.props,
			details: formatted.details,
			sidebarImages: formatted.sidebarImgs,
		})
	}
	return [notes, media]
}

async function formatMd(
	md: string,
	filename: string,
	media: TFile[],
	converter: MarkdownIt
): Promise<{
	chunks: ContentChunk[]
	lead: string
	props: NoteProperties
	details: Detail[]
	sidebarImgs: SidebarImage[]
}> {
	const { md: filteredMd, codeBlocks } = removeCodeblocks(md)

	md = normalizeWhitespace(filteredMd)
	const {
		md: newMd,
		props,
		details,
		sidebarImages,
	} = await replaceCustomBlocks(md, converter, media, filename)
	md = replaceBlockElements(newMd, converter)
	md = replaceInlineElements(md)

	md = addCodeblocksBack(md, codeBlocks, filename)

	// Get everything until the first header as the lead
	const match = md.match(/\n*#*(.+?)(?=#)/s)
	let lead = match ? match[1] : md

	// Remove wikilinks from lead
	lead = unwrapWikilinks(lead, { removeTransclusions: true })

	// Split by :::secret::: blocks
	const chunks = chunkMd(md, props.allowed_users)
	return {
		chunks: chunks,
		lead: lead,
		props: props,
		details: details,
		sidebarImgs: sidebarImages,
	}
}

/**
 * Replaces codeblocks in the markdown and replaces them with plain text identifiers of the form
 * <|codeblock_i|> where i is the number of the codeblock from the top of the page starting from 1.
 * Intended to be coupled with `addCodeblocksBack` to prevent codeblocks from affecting other markdown
 * transformations.
 * @param md The markdown to transform
 * @returns The markdown text with codeblocks replaced by identifiers and the list of codeblocks
 */
function removeCodeblocks(md: string) {
	// Remove codeblocks from the markdown as anything inside of them should be kept as is
	// Instead, add a generic marker to know where the codeblocks were and add them back later
	const codeBlockRegex = /^```(\w*)\n(.*?)\n```/gms
	const codeMatches = md.matchAll(codeBlockRegex)
	const codeBlocks: string[] = Array.from(codeMatches)
		.map((match) => {
			if (match[1] === "mermaid") {
				return match[0].replace(
					/^```mermaid\n(?:---(.*?)---)?(.*?)\n```/gms,
					replaceMermaidDiagram
				)
			} else {
				return highlightCode(match[0], match[1], match[2]) // Also highlight the code
			}
		})
		.filter((block) => block !== "")

	let counter = 0
	md = md.replace(codeBlockRegex, () => {
		counter += 1
		return `<|codeblock_${counter}|>`
	})

	return { md, codeBlocks }
}

/**
 * Transforms the markdown to add codeblocks removed by `removeCodeblocks` back in the text. The logic is
 * simple: the number in each codeblock identifier minus 1 is the index of the correct codeblock in the given array.
 * Make sure the length of `codeBlocks` is equal to the number of identifiers in the text. This function will not
 * throw an error if the indexes are mismatched. It will just return the markdown without transforming it.
 * @param md The markdown to transform
 * @param codeBlocks A string array of codeblocks
 * @param filename The filename of the file being processed
 * @returns The transformed markdown, with all codeblocks put back in place
 */
function addCodeblocksBack(
	md: string,
	codeBlocks: string[],
	filename: string
): string {
	// Add the codeblocks back in
	try {
		md = md.replace(
			/<\|codeblock_(\d+)\|>/g,
			(_match, index) => codeBlocks[index - 1]
		)
	} catch (e) {
		console.error(
			`There was an error parsing codeblocks in ${filename}. Error: ${e.message}`
		)
		new Notice(
			`There was an error parsing codeblocks in ${filename}. Error: ${e.message}`
		)
	}

	return md
}

function normalizeWhitespace(md: string): string {
	md = md.replace(/\n^(#+\s)/gm, "\n\n$1") // Double newlines before headers
	md = md.replace(/^(\s*)(\d\..*?)\n(?=[^0-9\s])/gm, "$1$2\n\n") // Double newlines after ordered lists
	md = md.replace(/^(\s*)([-*][^-*\n]*?)\n(?=[^-*\s])/gm, "$1$2\n\n") // Double newlines after unordered/task lists
	md = md.replace(/\n{2,}(?=\[\^\d\]:)/g, "\n\n") // Normalize newlines before footnotes
	md = md.replace(/\n{4,}(?!\[\^\d\]:)/g, (match) => "\n" + "<br />".repeat(match.length - 1)) // Preserve multiple newlines
	md = md.replace(/ {2,}/g, (match) => "&nbsp;".repeat(match.length)) // Preserve multiple spaces
	return md	
}

/**
 * Parses the given markdown text, removes all :::blocks::: and returns the related data structures.
 * This function ignores the :::secret::: blocks. Use the `chunkMd` function to split the page by those.
 * @param md The markdown text to transform
 * @param filename The name of the file that's being processed
 * @param media Global reference to the list of stored media
 * @returns The modified text, alongside all other additional data from custom blocks
 */
async function replaceCustomBlocks(
	md: string,
	converter: MarkdownIt,
	media: TFile[],
	filename: string
) {
	// Remove :::hidden::: blocks
	md = md.replace(/^:::hidden\n.*?\n:::/gms, "")

	// Collect all properties
	const propsRegex = /^---\r?\n(.*?)\r?\n---/s
	const propsMatch = md.match(propsRegex)
	let props: NoteProperties = {
		publish: false,
		frontpage: false,
		alt_title: undefined,
		allowed_users: [],
	}
	if (propsMatch) {
		props = parseProperties(propsMatch[1]) // Save some properties before removing them
		md = md.replace(propsRegex, "") // Remove obsidian properties
	}

	// Find and parse the first :::details::: block
	const detailsRegex = /^:::details\n(.*?)\n:::/ms
	const detailsMatch = md.match(detailsRegex)
	let details: Detail[] = []
	if (detailsMatch) {
		details = parseDetails(detailsMatch[1], converter, filename)
		if (details.length === 0) {
			new Notice(`Improperly formatted :::details::: in ${filename}`)
			console.warn(`Improperly formatted :::details::: in ${filename}`)
		}
		md = md.replace(detailsRegex, "")
	}

	// Find and parse all :::image::: blocks, uploading all new images
	const imageRegex = /^:::image\n(.*?)\n:::/gms
	const imageMatch = Array.from(md.matchAll(imageRegex))
	const sidebarImages: SidebarImage[] = []
	for (const i in imageMatch) {
		const index = parseInt(i)
		const match = imageMatch[index]
		sidebarImages.push(
			await parseImage(match[1], index + 1, media, converter, filename)
		)
		md = md.replace(match[0], "")
	}

	return { md, props, details, sidebarImages }
}

/**
 * Parses the given markdown text to transform block- or page-level markdown syntax that comes from
 * non-standard markdown flavors (Obsidian and GitHub) and would therefore not be recognized by MarkdownIt.
 * @param md The markdown to transform
 * @param converter A MarkdownIt converter to render the HTML inside of some blocks
 * @returns The transformec markdown
 */
function replaceBlockElements(md: string, converter: MarkdownIt): string {
	md = md.replace(
		// Replace callouts
		/^> +\[!(\w+)\] *(.*)(?:\n(>[^]*?))?(?=\n[^>])/gm,
		(match, type, title, content) =>
			replaceCallouts(match, type, title, content, converter)
	)
	md = md.replace(/^\t*[-*] +\[(.)\](.*)/gm, replaceTaskLists) // Add task lists
	md = md.replace(
		// Wrap the tasks in a <ul>
		/^<li>.*(\n<li>.*)*/gm,
		(match) => `<ul class="indent-cascade">${match}</ul>`
	)
	md = md.replace(
		// Adds links to footnotes
		/\b\[\^(\d+)\]/g,
		`<sup><a class="no-target-blank anchor" href="#footnote-$1">[$1]</a></sup>`
	)
	md = replaceFootnotes(md) // Add the actual footnotes at the bottom of the page

	return md
}

/**
 * Parses the given markdown text to transform inline markdown syntax that comes from non-standard
 * markdown flavors (Obsidian and GitHub) and would therefore not be recognized by MarkdownIt. This
 * does not convert wikilinks.
 * @param md The markdown to transform
 * @returns The transformec markdown
 */
function replaceInlineElements(md: string): string {
	md = md.replace(
		// Highlight text
		/==(.*?)==/g,
		'<span class="bg-tertiary-50-900-token">$1</span>'
	)
	md = md.replace(/%%.*?%%/gs, "") // Remove Obsidian comments
	md = md.replace(/\\\\/gs, "\\\\\\\\") // Double double backslashes before markdownIt halves them

	return md
}

function parseProperties(match: string): NoteProperties {
	const props: NoteProperties = {
		publish: false,
		frontpage: false,
		alt_title: undefined,
		allowed_users: [],
	}
	let temp = ""
	const propsLines: string[] = []
	match
		.split(":")
		.flatMap((line) => line.split("\n"))
		.filter((line) => line !== "")
		.forEach((line, index) => {
			if (index === 0) {
				temp = `${line.trim()}: `
			} else if (line.startsWith(" ")) {
				temp += `${line.trim()}|`
			} else {
				propsLines.push(temp.replace(/\|$/, ""))
				temp = `${line.trim()}: `
			}
		})
	propsLines.push(temp.replace(/\|$/, ""))

	for (const line of propsLines) {
		const [key, value] = line.split(": ")
		switch (key) {
			case "wiki-publish":
			case "dg-publish":
				if (value === "true") props.publish = true
				break
			case "wiki-home":
			case "dg-home":
				if (value === "true") props.frontpage = true
				break
			case "wiki-title":
			case "dg-title":
				props.alt_title = value
				break
			case "wiki-allowed-users":
				props.allowed_users = value
					.split("|")
					.map((username) => username.replace(/^- /, ""))
				props.allowed_users.forEach((username) => username.trim())
				break
			default:
				break
		}
	}

	return props
}

function parseDetails(
	match: string,
	converter: MarkdownIt,
	filename: string
): Detail[] {
	const detailsList: Detail[] = []
	const details = match.split("\n").filter((line) => line !== "")

	for (const i in details) {
		const index = parseInt(i)
		const detail = details[i]
		const split = detail.split(/:\s*/)
		if (split.length > 2 || split.length === 0) {
			new Notice(`Improperly formatted :::details::: in ${filename}`)
			console.warn(`Improperly formatted :::details::: in ${filename}`)
			return [{ order: 1, key: "", value: "" }]
		}
		if (split.length === 1) {
			let k = replaceInlineElements(split[0])
			k = converter.renderInline(k)
			detailsList.push({
				order: index + 1,
				key: k,
				value:"",
			})
		} else {
			let [k, v] = split
			// k = k.replace(/^(_|\*)+/, "").replace(/(_|\*)+$/, "")
			k = replaceInlineElements(k)
			k = converter.renderInline(k)

			v = replaceInlineElements(v)
			v = converter.renderInline(v)
			detailsList.push({
				order: index + 1,
				key: k,
				value: v
			})
		}
	}

	return detailsList
}

async function parseImage(
	blockContents: string,
	index: number,
	media: TFile[],
	converter: MarkdownIt,
	currFile: string
): Promise<SidebarImage> {
	let filename: string | undefined
	let caption: string | undefined

	// Parse markdown for filename and captions
	// Unlike wikilinks, there's no need to check for user-defined dimensions
	const lines = blockContents.split("\n").filter((line) => line !== "")
	if (lines.length === 0) {
		console.warn(`Error parsing :::image::: block in ${currFile}.`)
		new Notice(`Error parsing :::image::: block in ${currFile}.`)
		return {
			order: index,
			image_name: "Error",
			url: undefined,
			caption: undefined,
		}
	}

	// Grab the filename from the wikilink
	const wikilink = lines[0].match(/!\[\[(.*?)(\|.*)?\]\]/)
	if (wikilink) {
		filename = wikilink[1]
	} else {
		console.warn(
			`Could not read filename in :::image::: block in ${currFile}.`
		)
		new Notice(
			`Could not read filename in :::image::: block in ${currFile}.`
		)
		return {
			order: index,
			image_name: "Error",
			url: undefined,
			caption: undefined,
		}
	}

	// Then the caption, if present
	if (lines.length > 1) {
		caption = lines.splice(1).join("\n")
		// .replace(/^[*_]*/, "")
		// .replace(/[*_]*$/, "")
		caption = replaceInlineElements(caption)
		caption = converter.renderInline(caption)
	}

	// Grab that media file from the vault, if it exists. If it doesn't, it not might be a problem
	const refFile = media.find((file) => file.name === filename)
	if (!refFile) {
		console.warn(
			`Could not find file "${filename}". If this file doesn't yet exist, this is expected`
		)
		return {
			order: index,
			image_name: filename,
			url: undefined,
			caption: caption,
		}
	}

	// If it exists, read it as a binary ArrayBuffer and upload it
	const refFileBinary = await globalVault.readBinary(refFile)
	const url = await uploadImage(refFileBinary, filename)
	return {
		order: index,
		image_name: filename,
		url: url,
		caption: caption,
	}
}

function replaceCallouts(
	_match: string,
	type: string,
	title: string,
	content: string,
	converter: MarkdownIt
) {
	let color: string
	let svg: string
	switch (type.toLowerCase()) {
		case "info":
			color = "primary"
			svg = calloutIcons.info
			break
		case "question":
		case "faq":
		case "help":
			color = "warning"
			svg = calloutIcons.circleQuestion
			break
		case "tip":
		case "important":
		case "hint":
			color = "tertiary"
			svg = calloutIcons.flame
			break
		case "success":
		case "check":
		case "done":
			color = "success"
			svg = calloutIcons.check
			break
		case "todo":
			color = "primary"
			svg = calloutIcons.circleCheck
			break
		case "warning":
		case "caution":
		case "attention":
			color = "warning"
			svg = calloutIcons.alertTriangle
			break
		case "failure":
		case "fail":
		case "missing":
			color = "error"
			svg = calloutIcons.cross
			break
		case "danger":
		case "error":
			color = "error"
			svg = calloutIcons.zap
			break
		case "bug":
			color = "error"
			svg = calloutIcons.bug
			break
		case "example":
			color = "secondary"
			svg = calloutIcons.list
			break
		case "quote":
		case "cite":
			color = "surface"
			svg = calloutIcons.quote
			break
		case "abstract":
		case "summary":
		case "tldr":
			color = "tertiary"
			svg = calloutIcons.clipboard
			break
		default:
			color = ""
			svg = ""
			break
	}

	// Remove all the leading "> " from the callout
	content = content
		.split("\n")
		.map((line) => {
			line = line.replace(/^> */, "")
			return `${line}`
		})
		.filter((line) => line !== "")
		.join("\n")
	// Convert the content to HTML here as it will be ignored later
	content = converter.render(content)

	return `<div class="callout-${color}"><div class="flex"><div class="w-8 stroke-${color}-400">${svg}</div><div class="pb-2"><strong>${title}</strong></div></div><section class="space-y-4">${content}</section></div>`
}

function highlightCode(_match: string, lang: string, code: string) {
	let displayCode: string
	const langs = hljs.listLanguages()
	if (lang && langs.includes(lang)) {
		displayCode = hljs.highlight(code, {
			language: lang,
			ignoreIllegals: true,
		}).value
	} else {
		displayCode = code
			.split("\n")
			.map((line) => (line !== "" ? `<p>${line}<p>` : "<br />"))
			.join("")
	}

	return `<div class="codeblock-base"><header class="codeblock-header"><span>${lang}</span></header><pre class="codeblock-pre">${displayCode}</pre></div>\n`
}

function replaceTaskLists(
	_match: string,
	char: string,
	content: string
): string {
	const checked = char !== " " ? "checked" : ""
	const linethrough = char === "x" ? "line-through" : ""
	return `<li><input type="checkbox" class="task-checkbox" ${checked} /><span class="${linethrough}">${content}</span></li>`
}

function replaceFootnotes(text: string) {
	// Find the index of the last numerical footnote. Necessary to calculate the index of inline footnotes
	const footnoteMatch = text.match(/(?<=\n)\[\^(\d+)\].*$/) ?? undefined
	let lastFootnoteIndex = footnoteMatch ? parseInt(footnoteMatch[1]) : 1
	const inlineFootnotes: string[] = []

	if (footnoteMatch) {
		// Format footnotes at the bottom of the note
		text = text.replace(/(?<=\n)\[\^\d+\].*$/s, (match) => {
			const lines = match.split("\n")
			let out = `<hr /><div>`
			for (let line of lines) {
				line = line.replace(
					/^\[\^(\d+)\]: +(.*)/,
					`<p id="footnote-$1"><span class="text-slate-500 mr-2">^$1</span>$2</p>\n`
				)
				out += line
			}
			return out
		})
	}

	// And append inline footnotes while adding links
	text = text.replace(/\b\^\[(.+?)\]/g, (_match, footnote) => {
		const idx = lastFootnoteIndex + 1
		inlineFootnotes.push(
			`<p id="footnote-${idx}"><span class="text-slate-500 mr-2">^${idx}</span>${footnote}</p>\n`
		)
		lastFootnoteIndex += 1
		return `<sup><a class="no-target-blank anchor" href="#footnote-${idx}">[${idx}]</a></sup>`
	})
	inlineFootnotes.forEach((footnote) => (text += footnote))

	if (footnoteMatch) text += "</div>"

	return text
}

function replaceMermaidDiagram(
	_match: string,
	frontmatter: string | undefined,
	graphDefinition: string
): string {
	if (!frontmatter) frontmatter = ""
	// Check if a config exists in the frontmatter
	const configMatch = frontmatter.match(/^config:/gm)
	if (configMatch) {
		// If it does, check if a theme is also defined
		const themeMatch = frontmatter.match(/^\s*theme:/gm)
		if (!themeMatch) {
			// If not, add the dark theme
			frontmatter = frontmatter.replace(
				/^config:/gm,
				"config:\n  theme: dark\n"
			)
		} // else keep the user defined one
	} else {
		// If there is no config (or no frontmatter) add it alongside the dark theme
		frontmatter += "config:\n  theme: dark"
	}

	return `<pre class="mermaid">---\n${frontmatter}\n---\n${graphDefinition}</pre>`
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

function fixHtml(html: string): string {
	// Improve headers
	html = html.replace(
		/<h(\d)(.*?)>(.*?)<\/h\1>/g,
		(_substring, num, props, content) => {
			const id = slugifyPath(content)
			return `<h${num}${props} class="h${num}" id="${id}">${content}</h${num}>`
		}
	)
	// Make all external links open a new tab, except ones that are marked as internal
	html = html.replace(
		/<a(?![^>]*class="no-target-blank anchor")(.*?)>(.*?)<\/a>/g,
		'<a$1 class="anchor" target="_blank">$2</a>'
	)
	// Add tailwind classes to blockquotes, code, lists and tables
	html = html.replace(
		/<blockquote>/g,
		'<blockquote class="blockquote whitespace-pre-wrap break-all">'
	)
	html = html.replace(
		/<ul(.*?)>/g,
		'<ul$1 class="list-disc list-inside indent-cascade">'
	)
	html = html.replace(
		/<ol(.*?)>/g,
		'<ol$1 class="list-decimal list-inside indent-cascade">'
	)
	html = html.replace(/<code>/g, '<code class="code">')
	html = html.replace(/<table>/g, '<table class="border-collapse">')
	html = html.replace(
		/<th>/g,
		'<th class="border border-surface-400-500-token py-1 px-2">'
	) // <th> are replaced in two steps to avoid accidentally matching <thead>
	html = html.replace(
		/<th +(.*?)>/g,
		'<th class="border border-surface-400-500-token py-1 px-2" $1>'
	)
	html = html.replace(
		/<td(.*?)>/g,
		'<td class="border border-surface-400-500-token py-1 px-2" $1>'
	)

	return html
}

function unwrapWikilinks(
	text: string,
	options?: {
		removeReferences?: boolean
		removeTransclusions?: boolean
	}
): string {
	if (options?.removeTransclusions) {
		text = text.replace(/!\[\[(.*?)(#\^?.*?)?(\|.*?)?\]\]/g, "")
	} else {
		text = text.replace(/!\[\[(.*?)(#\^?.*?)?(\|.*?)?\]\]/g, "$1")
	}

	if (options?.removeReferences) {
		text = text.replace(/\[\[(.*?)(#\^?.*?)?(\|.*?)?\]\]/g, "")
	} else {
		text = text.replace(/\[\[(.*?)(#\^?.*?)?(\|.*?)?\]\]/g, "$1")
	}

	return text
}
