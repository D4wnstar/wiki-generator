import { App, Component, MarkdownRenderer, TFile } from "obsidian"
import { slugPath } from "src/utils"
import { handleCustomSyntax } from "./custom-blocks"
import { Frontmatter, Note, Page } from "../database/types"

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
	const { md, details, sidebarImages } = await handleCustomSyntax(
		content,
		file.name,
		app,
		titleToSlug,
		imageNameToPath
	)

	// Convert the entire markdown to HTML using Obsidian's builtin renderer
	const html = await mdToHtml(md, app, titleToSlug, imageNameToPath)

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

	// Move data-heading to id on <hN>
	for (const h of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
		const headers = Array.from(doc.querySelectorAll(h))
		for (const header of headers) {
			const id = header.getAttribute("data-heading")
			if (id) header.setAttribute("id", id)
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
		}
		const code = pre.querySelector("code")
		if (code && code.classList.length === 0) {
			code.className = "language-markdown"
		}
	}

	// Text transclusions: Remove empty tags
	doc.querySelectorAll("div.markdown-embed-title").forEach((div) =>
		div.remove()
	)
	doc.querySelectorAll("p:has(> span.markdown-embed)").forEach((p) =>
		p.remove()
	)

	// Text transclusions: Change classes
	doc.querySelectorAll("div.markdown-preview-view").forEach(
		(div) => (div.className = "note-transclusion")
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

	return doc.body.innerHTML
}
