import { slug } from "github-slugger"
import type { Element, ElementContent, Root } from "hast"
import { h } from "hastscript"
import { slugPath } from "src/utils"
import { partition } from "src/utils"
import { visit } from "unist-util-visit"

const wikilinkRegexNoGroups = /!?\[\[.*?(?:#\^?.*?)?(?:\|.*?)?\]\]/g
const wikilinkRegex = /(!)?\[\[(.*?)(#\^?.*?)?(\|.*?)?\]\]/
// Capture groups:
//  0. ! (Transclusion or not)
//  1. Linked page title
//  2. Internal header
//  3. Alias

export default function rehypeWikilinks(
	titleToPath: Map<string, string>,
	imageBase64: Map<string, string>
) {
	return function (tree: Root) {
		visit(tree, "element", (e) =>
			handleElement(e, titleToPath, imageBase64)
		)
	}
}

function handleElement(
	elem: Element,
	titleToPath: Map<string, string>,
	imageBase64: Map<string, string>
) {
	// Ignore code and pre blocks
	if (
		elem.children.length === 0 ||
		elem.tagName === "code" ||
		elem.tagName === "pre"
	) {
		return
	}
	let idx = 0
	//eslint-disable-next-line
	while (true) {
		const currChild = elem.children[idx]
		// Loop until there are children nodes
		if (!currChild || idx > 1000) {
			break
		}
		// Ignore anything that's not text
		if (currChild.type !== "text") {
			idx += 1
			continue
		}

		const text = currChild.value
		const parts = partition(text, wikilinkRegexNoGroups, 1)
		if (parts.length !== 3) {
			idx += 1
			continue
		}
		const preNode = {
			type: "text",
			value: parts[0],
		} as ElementContent
		const postNode = {
			type: "text",
			value: parts[2],
		} as ElementContent

		const props = findWikilinkProperties(parts[1], titleToPath, imageBase64)

		let linkNode: ElementContent
		if (props instanceof Wikilink) {
			linkNode = props.remove
				? ({
						type: "text",
						value: props.linkText,
				  } as ElementContent)
				: h("a", { class: props.class, href: props.href }, [
						props.linkText,
				  ])
		} else {
			linkNode = h(
				"img",
				{
					class: "mx-auto",
					src: props.base64,
					alt: props.alt,
				},
				[]
			)
		}
		elem.children.splice(idx, 1, ...[preNode, linkNode, postNode])

		idx += 1
	}
}

class Wikilink {
	linkText: string
	href: string
	class: string
	remove: boolean

	constructor(
		linkText: string,
		href: string,
		class_: string,
		remove: boolean
	) {
		this.linkText = linkText
		this.href = href
		this.class = class_
		this.remove = remove
	}
}

class Img {
	base64: string
	alt: string

	constructor(base64: string, alt: string) {
		this.base64 = base64
		this.alt = alt
	}
}

function findWikilinkProperties(
	link: string,
	titleToPath: Map<string, string>,
	imageBase64: Map<string, string>
): Wikilink | Img {
	const rmatch = link.match(wikilinkRegex)
	if (!rmatch) {
		return {
			linkText: link,
			href: "",
			class: "",
			remove: true,
		}
	}

	const isTransclusion = rmatch[1] === "!"
	const pageTitleOrPath = rmatch[2]
	const header = rmatch[3]
	const alias = rmatch[4]

	const hasFileExtension = pageTitleOrPath.match(/\..*$/)
	if (!isTransclusion) {
		if (!hasFileExtension) {
			return handleTextReference(
				pageTitleOrPath,
				header,
				alias,
				titleToPath
			)
		} else {
			// TODO: Handle a file reference
			return {
				linkText: "[img here lol]",
				href: "",
				class: "",
				remove: true,
			}
		}
	} else {
		if (!hasFileExtension) {
			// TODO: Handle a text transclusion
			return {
				linkText: "[text here lol]",
				href: "",
				class: "",
				remove: true,
			}
		} else {
			return handleFileTransclusion(pageTitleOrPath, alias, imageBase64)
		}
	}
}

function handleTextReference(
	pageTitleOrPath: string,
	header: string | undefined,
	alias: string | undefined,
	titleToPath: Map<string, string>
): Wikilink {
	let path
	if (pageTitleOrPath?.includes("/")) {
		path = slugPath(pageTitleOrPath)
	} else {
		path = titleToPath.get(pageTitleOrPath?.toLowerCase())
	}
	const headerLink = header ? `#${slug(header)}` : ""
	const refName = alias?.replace("|", "") ?? pageTitleOrPath

	// If path is not found, that means the note is not published
	// and the link should be remove
	return new Wikilink(
		refName,
		`/${path}${headerLink}`,
		"anchor popup",
		path === undefined
	)
}

function handleFileTransclusion(
	imageTitleOrPath: string,
	dimensions: string | undefined,
	imageBase64: Map<string, string>
): Img {
	// TODO: Add support for full path
	const base64 = imageBase64.get(imageTitleOrPath) ?? ""

	return new Img(`data:image/png;base64,${base64}`, imageTitleOrPath)
}
