import { App, Component, MarkdownRenderer, TFile } from "obsidian"
import { slugPath } from "src/utils"
import { handleCustomSyntax } from "./custom-blocks"
import { Frontmatter, Note, Page } from "../database/types"
import katex from "katex"

export async function createPage(
	file: TFile,
	hash: string,
	titleToSlug: Map<string, string>,
	imageNameToPath: Map<string, string>,
	app: App
): Promise<Page | null> {
	const content = await app.vault.cachedRead(file)
	const frontmatter = await extractFrontmatter(content)

	// Skip anything that's not published
	if (!frontmatter["wiki-publish"]) return null

	// Parse and replace custom :::blocks::: and other non-standard syntax
	const { md, details, sidebarImages, math } = await handleCustomSyntax(
		content,
		file.name,
		app,
		titleToSlug,
		imageNameToPath
	)

	// Convert the entire markdown to HTML using Obsidian's builtin renderer
	let html = await mdToHtml(md, app, titleToSlug, imageNameToPath)

	// Add KaTeX math manually
	html = html.replace(/\|math\|(<br>)?/g, () =>
		katex.renderToString(math.block.pop() ?? "", { displayMode: true })
	)
	html = html.replace(/\|math-inline\|/g, () =>
		katex.renderToString(math.inline.pop() ?? "")
	)

	// Get aliases as search terms
	const title = file.basename
	const alt_title = frontmatter["wiki-title"] ?? null
	const aliases = frontmatter["aliases"]?.join("; ") as string | undefined
	let search_terms = title
	search_terms += alt_title ? `; ${alt_title}` : ""
	search_terms += aliases ? `; ${aliases}` : ""

	// A page can be prerendered if it does not depend on user permission
	const allowed_users = frontmatter["wiki-allowed-users"]?.join("; ") ?? null

	const note: Note = {
		title,
		alt_title,
		search_terms,
		path: file.path,
		slug: titleToSlug.get(title) ?? slugPath(file.path),
		frontpage: frontmatter["wiki-home"] ?? 0,
		lead: "", // Currently unused, needed for popups once they are reimplemented
		allowed_users,
		hash,
		last_updated: Math.floor(Date.now() / 1000),
		can_prerender: Number(!allowed_users),
		html_content: html,
	}

	return {
		note,
		details,
		sidebarImages,
	}
}

// TODO: Use the builtin frontmatter API
/**
 * Extract frontmatter from markdown content
 * @param content The markdown content
 * @returns The frontmatter object
 */
async function extractFrontmatter(content: string): Promise<Frontmatter> {
	// Simple frontmatter extraction
	const frontmatterRegex = /^---\n([\s\S]*?)\n---/
	const match = content.match(frontmatterRegex)

	if (match) {
		const frontmatterContent = match[1]
		const frontmatter: Frontmatter = {} as Frontmatter

		// Parse each line
		const lines = frontmatterContent.split("\n")
		for (const line of lines) {
			const [key, ...valueParts] = line.split(":")
			const value = valueParts.join(":").trim()

			if (key && value) {
				// Handle boolean values
				if (value === "true") {
					frontmatter[key.trim() as keyof Frontmatter] = true as any
				} else if (value === "false") {
					frontmatter[key.trim() as keyof Frontmatter] = false as any
				} else if (value.startsWith("[") && value.endsWith("]")) {
					// Handle array values
					const arrayContent = value.substring(1, value.length - 1)
					frontmatter[key.trim() as keyof Frontmatter] = arrayContent
						.split(",")
						.map((item) => item.trim()) as any
				} else {
					// Handle string values
					frontmatter[key.trim() as keyof Frontmatter] = value as any
				}
			}
		}

		return frontmatter
	}

	return {} as Frontmatter
}

export async function mdToHtml(
	md: string,
	app: App,
	titleToPath: Map<string, string>,
	imageNameToPath: Map<string, string>
) {
	// Create a temporary element to render the markdown to
	const tempEl = document.createElement("div")

	try {
		await MarkdownRenderer.render(app, md, tempEl, "", new Component())
		return postprocessHtml(tempEl.innerHTML, titleToPath, imageNameToPath)
	} finally {
		tempEl.remove()
	}
}

export function postprocessHtml(
	html: string,
	titleToPath: Map<string, string>,
	imageNameToPath: Map<string, string>
) {
	const parser = new DOMParser()
	const doc = parser.parseFromString(html, "text/html")

	// Remove frontmatter
	doc.querySelectorAll("pre.frontmatter").forEach((pre) => pre.remove())

	// Change link URLs to be actual website URLs
	const links = Array.from(doc.querySelectorAll("a")).reverse()
	for (const link of links) {
		link.removeAttribute("data-href")

		const href = link.getAttribute("href")
		if (!href) continue
		if (link.className.includes("external-link")) continue

		// Remove target="_blank" from internal links
		link.removeAttribute("target")

		// Leave internal links alone
		if (href.startsWith("#")) continue

		// For links to other pages, try to resolve the slug
		// Remove any hash fragment for lookup
		const hashIndex = href.indexOf("#")
		const pageKey = hashIndex > -1 ? href.substring(0, hashIndex) : href

		if (titleToPath.has(pageKey)) {
			const slug = titleToPath.get(pageKey) as string
			const sub =
				hashIndex > -1
					? `/${slug}${href.substring(hashIndex)}`
					: `/${slug}`
			link.setAttribute("href", sub)
		} else if (imageNameToPath.has(pageKey)) {
			const slug = imageNameToPath.get(pageKey) as string
			const path = encodeURIComponent(slug)
			link.setAttribute("href", `/api/v1/image/${path}`)
		} else {
			// If no slug is found, unwrap the anchor tag
			const parent = link.parentNode
			while (link.firstChild) {
				parent?.insertBefore(link.firstChild, link)
			}
			parent?.removeChild(link)
		}
	}

	// Handle <img> sources
	const imgs = Array.from(doc.querySelectorAll("img"))
	for (const img of imgs) {
		// The alt property contains the filename
		const alt = img.getAttribute("alt")
		if (!alt) continue
		const path = imageNameToPath.get(alt)
		if (path) {
			const component = encodeURIComponent(path)
			img.setAttribute("src", `/api/v1/image/${component}`)
		} else {
			img.removeAttribute("src")
		}
	}

	// Support for Excalidraw
	const excImgs = Array.from(
		doc.querySelectorAll("img.excalidraw-embedded-img")
	)
	for (const img of excImgs) {
		const path = img.getAttribute("filesource")?.replace(/\.md$/, ".svg")
		if (path) {
			img.setAttribute("src", `/api/v1/image/${encodeURIComponent(path)}`)
		} else {
			img.removeAttribute("src")
		}
	}

	// Move data-heading to id on <hN>
	for (const h of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
		const headers = Array.from(doc.querySelectorAll(h))
		for (const header of headers) {
			const id = header.getAttribute("data-heading")
			if (id) header.setAttribute("id", encodeURIComponent(id))
			header.removeAttribute("data-heading")
		}
	}

	// Remove copy code buttons
	doc.querySelectorAll("button.copy-code-button").forEach((btn) =>
		btn.remove()
	)

	// Default code blocks to markdown if language is unspecified (prevents unstyled code blocks)
	const presWithCode = Array.from(doc.querySelectorAll("pre:has(> code)"))
	for (const pre of presWithCode) {
		if (pre.classList.length === 0) {
			pre.className = "language-markdown"
			const code = pre.querySelector("code")
			if (code && code.classList.length === 0) {
				code.className = "language-markdown"
			}
		} else if (pre.className === "language-mermaid") {
			// pre.className = "mermaid"
		}
	}

	// Text embeds: Remove empty tags
	doc.querySelectorAll("div.markdown-embed-title").forEach((div) =>
		div.remove()
	)
	doc.querySelectorAll("p:has(> span.markdown-embed)").forEach((p) =>
		p.remove()
	)

	// Text embeds: Change classes
	doc.querySelectorAll("div.markdown-preview-view").forEach(
		(div) => (div.className = "note-embed")
	)

	// Disable checklist checkboxes
	doc.querySelectorAll("input.task-list-item-checkbox").forEach((input) =>
		input.setAttribute("disabled", "")
	)

	// Unwrap images nested in p > span > img to be top-level img elements
	const nestedImages = Array.from(
		doc.querySelectorAll("p > span.image-embed > img")
	)
	for (const img of nestedImages) {
		const span = img.parentElement
		const p = span?.parentElement

		// If we have all the elements, move the img to be a sibling of the p
		if (p && span) {
			p.parentNode?.insertBefore(img, p)
			span.remove()
			p.remove()
		}
	}

	// Callout icons are not available in the rendered HTML (probably added by JS after render)
	// so we do the same here (icons are below)
	const callouts = Array.from(doc.querySelectorAll(".callout"))
	for (const callout of callouts) {
		const icon = callout.querySelector(".callout-icon")
		const calloutType = callout.getAttribute("data-callout")
		if (!icon || !calloutType) continue
		const svg = calloutIcons[calloutType]
		if (!svg) continue

		icon.innerHTML = svg
	}

	return doc.body.innerHTML
}

const calloutIcons: Record<string, string> = {
	abstract: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-clipboard-list-icon lucide-clipboard-list"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/></svg>`,
	attention: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-triangle-alert-icon lucide-triangle-alert"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`,
	bug: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-bug-icon lucide-bug"><path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/></svg>`,
	caution: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-triangle-alert-icon lucide-triangle-alert"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`,
	check: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check-icon lucide-check"><path d="M20 6 9 17l-5-5"/></svg>`,
	cite: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-quote-icon lucide-quote"><path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/></svg>`,
	danger: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-zap-icon lucide-zap"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg>`,
	done: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check-icon lucide-check"><path d="M20 6 9 17l-5-5"/></svg>`,
	error: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-zap-icon lucide-zap"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg>`,
	fail: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x-icon lucide-x"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
	failure: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x-icon lucide-x"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
	faq: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-question-mark-icon lucide-circle-question-mark"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>`,
	help: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-question-mark-icon lucide-circle-question-mark"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>`,
	hint: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-flame-icon lucide-flame"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`,
	important: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-flame-icon lucide-flame"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`,
	info: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-info-icon lucide-info"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`,
	example: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-list-icon lucide-list"><path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/></svg>`,
	missing: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x-icon lucide-x"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
	question: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-question-mark-icon lucide-circle-question-mark"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>`,
	quote: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-quote-icon lucide-quote"><path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/></svg>`,
	success: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check-icon lucide-check"><path d="M20 6 9 17l-5-5"/></svg>`,
	tip: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-flame-icon lucide-flame"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`,
	todo: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-check-icon lucide-circle-check"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>`,
	warning: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-triangle-alert-icon lucide-triangle-alert"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`,
}
