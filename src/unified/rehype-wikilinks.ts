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
	imageNameToPath: Map<string, string>
) {
	return function (tree: Root) {
		visit(tree, "element", (e) =>
			handleElement(e, titleToPath, imageNameToPath)
		)
	}
}

function handleElement(
	elem: Element,
	titleToPath: Map<string, string>,
	imageNameToPath: Map<string, string>
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
		const parts = partition(text, wikilinkRegexNoGroups, { limit: 1 })
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

		const props = findWikilinkProperties(
			parts[1],
			titleToPath,
			imageNameToPath
		)

		const linkNode = props.remove
			? ({
					type: "text",
					value: props.linkText,
			  } as ElementContent)
			: h("a", { class: props.class, href: props.href }, [props.linkText])

		elem.children.splice(idx, 1, ...[preNode, linkNode, postNode])

		idx += 1
	}
}

type Wikilink = {
	linkText: string
	href: string
	class: string
	remove: boolean
}

function findWikilinkProperties(
	link: string,
	titleToPath: Map<string, string>,
	imageNameToPath: Map<string, string>
): Wikilink {
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
	const titleOrPath = rmatch[2]
	const header = rmatch[3]
	const alias = rmatch[4]

	const hasFileExtension = titleOrPath.match(/\..*$/)
	if (!isTransclusion) {
		if (!hasFileExtension) {
			return handleTextReference(titleOrPath, header, alias, titleToPath)
		} else {
			return handleImageReference(titleOrPath, imageNameToPath)
		}
	} else {
		// Transclusions are handled separately in the page chunking process
		return { linkText: titleOrPath, href: "", class: "", remove: true }
	}
}

function handleTextReference(
	pageTitleOrPath: string,
	header: string | undefined,
	alias: string | undefined,
	titleToPath: Map<string, string>
): Wikilink {
	const path = pageTitleOrPath.includes("/")
		? slugPath(pageTitleOrPath)
		: titleToPath.get(pageTitleOrPath.toLowerCase())

	const headerLink = header ? `#${slug(header)}` : ""
	const refName = alias?.replace("|", "") ?? pageTitleOrPath

	// If path is not found, that means the note is not published
	// and the link should be remove
	return {
		linkText: refName,
		href: `/${path}${headerLink}`,
		class: "anchor",
		remove: path === undefined,
	}
}

function handleImageReference(
	imageTitleOrPath: string,
	imageNameToPath: Map<string, string>
): Wikilink {
	const imageName = imageTitleOrPath?.includes("/")
		? imageTitleOrPath.split("/").last() ?? ""
		: imageTitleOrPath

	const imageId = imageNameToPath.get(imageName)
	return {
		linkText: imageTitleOrPath,
		href: `/api/v1/image?image_id=${imageId}`,
		class: "anchor",
		remove: false,
	}
}
