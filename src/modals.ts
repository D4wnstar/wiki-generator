import {
	SuggestModal,
	Editor,
	App,
	Notice,
	FuzzySuggestModal,
	MarkdownView,
} from "obsidian"
import { getPropertiesFromEditor, replacePropertiesFromEditor } from "./utils"
import { User } from "./database/types"

interface Property {
	name: string
	description: string
	valueType: string
	defaultValue: string
}

const BUILTIN_PROPS: Property[] = [
	{
		name: "wiki-publish",
		description:
			"If true, this page will be uploaded. If false or unset, it won't.",
		valueType: "true/false",
		defaultValue: "true",
	},
	{
		name: "wiki-home",
		description:
			"Set this note as the front page. Can only be true on one note.",
		valueType: "true/false",
		defaultValue: "true",
	},
	{
		name: "wiki-title",
		description:
			"By default, the title of a wiki page will be the same as the one in Obsidian. This property allows you to set a different title just for the wiki.",
		valueType: "text",
		defaultValue: "",
	},
	{
		name: "wiki-allowed-users",
		description:
			'A list of users who are allowed see this page. It will be hidden to everyone else. You can use the "Get registered users" command to get an updated list of registered users.',
		valueType: "a list of usernames. Press Enter to separate them",
		defaultValue: "[]",
	},
]

export class PropertyModal extends SuggestModal<Property> {
	editor: Editor

	constructor(app: App, editor: Editor) {
		super(app)
		this.editor = editor
	}

	getSuggestions(query: string): Property[] | Promise<Property[]> {
		return BUILTIN_PROPS.filter((prop) =>
			prop.name.includes(query.toLocaleLowerCase())
		)
	}

	renderSuggestion(value: Property, el: HTMLElement) {
		const propName = el.createEl("code", { text: value.name })
		propName.style.fontSize = "1.2em"

		const desc = el.createEl("p", { text: value.description })
		desc.style.display = "block"
		// desc.style.marginTop = "4px"
		// desc.style.marginBottom = "4px"

		el.createEl("span", {
			text: `Accepted values: ${value.valueType}`,
		})
	}

	onChooseSuggestion(
		selectedProp: Property,
		_evt: MouseEvent | KeyboardEvent
	) {
		const props = getPropertiesFromEditor(this.editor)
		props.set(selectedProp.name, selectedProp.defaultValue)
		let newProps = "---\n"
		for (const [k, v] of props.entries()) {
			newProps += `${k}: ${v}\n`
		}
		newProps += "---"

		replacePropertiesFromEditor(this.editor, newProps)

		new Notice(`Added ${selectedProp.name}`)
	}
}

interface CustomBlock {
	name: "hidden" | "image" | "details" | "secret"
	description: string
	args?: { key: string; value?: string; description: string }[]
}

const CUSTOM_BLOCKS: CustomBlock[] = [
	{
		name: "hidden",
		description:
			"Anything inside of a hidden block will be deleted when uploading. Useful to add comments or secrets that only you should read.",
	},
	{
		name: "image",
		description:
			"An image block will add a fancy interface to the image inside the block. Users will be able to click on it to expand its size. You can also add an optional caption.",
		args: [
			{
				key: "sidebar",
				description:
					"Adding the sidebar argument will extract the image from the document and add it in the sidebar.",
			},
		],
	},
	{
		name: "details",
		description:
			"A details block allows you to add a list of short pieces of information that will be extracted from the document and shown in the sidebar.",
	},
	{
		name: "secret",
		description:
			"The secret block accepts one or more usernames as arguments. Anything inside the block will only be shown to those users, even if the rest of the page is public. Useful if you want to a secret detail in a page that is otherwise available to everyone.",
		args: [
			{
				key: "<users>",
				description:
					'A list of usernames to show this block to. Use the "Get registered users" command for an updated list of registered usernames. Like all arguments, the list of usernames must be comma-separated.',
			},
		],
	},
]

export class BlockModal extends SuggestModal<CustomBlock> {
	editor: Editor

	constructor(app: App, editor: Editor) {
		super(app)
		this.editor = editor
	}

	getSuggestions(query: string): CustomBlock[] | Promise<CustomBlock[]> {
		return CUSTOM_BLOCKS.filter((block) =>
			block.name.includes(query.toLocaleLowerCase())
		)
	}

	renderSuggestion(value: CustomBlock, el: HTMLElement) {
		const blockName = el.createEl("code", { text: value.name })
		blockName.style.fontSize = "1.2em"

		const desc = el.createEl("p", { text: value.description })
		desc.style.display = "block"
		desc.style.marginTop = "4px"
		desc.style.marginBottom = "4px"

		if (value.args && value.args.length > 0) {
			const ul = el.createEl("ul")
			for (const arg of value.args) {
				const li = ul.createEl("li")
				li.createEl("span", { text: `Argument: ` })
				li.createEl("code", { text: arg.key })
				if (arg.value) {
					li.createEl("span", {
						text: `. Possible values: ${arg.value}`,
					})
				}
				li.createEl("span", { text: `. ${arg.description}` })
			}
		}
	}

	onChooseSuggestion(
		selectedBlock: CustomBlock,
		_evt: MouseEvent | KeyboardEvent
	) {
		let blockText = this.makeBlock(selectedBlock.name)
		const cursor = this.editor.getCursor()
		const currLine = this.editor.getLine(cursor.line)
		console.log(currLine)
		if (currLine.length > 0) {
			blockText = `\n\n${blockText}\n\n`
		}
		this.editor.replaceRange(blockText, cursor)
	}

	makeBlock(blockName: "hidden" | "image" | "details" | "secret") {
		let text = `:::${blockName}`
		switch (blockName) {
			case "hidden":
				text += "\nAnything here will not be uploaded"
				break
			case "image":
				text += "\n![[image goes here]]\nOptionally, caption goes here"
				break
			case "details":
				text += "\nDetail 1: Description 1\nDetail 2: Description 2"
				break
			case "secret":
				text +=
					"(users, here)\nAnything here will only be seen by these users"
		}
		text += "\n:::"

		return text
	}
}

export class UserListModal extends FuzzySuggestModal<User> {
	profiles: User[]

	constructor(app: App, profiles: User[]) {
		super(app)
		this.profiles = profiles
	}

	getItems(): User[] {
		return this.profiles
	}

	getItemText(profile: User): string {
		return profile.username
	}

	onChooseItem(profile: User, _evt: MouseEvent | KeyboardEvent): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView)
		if (view) {
			view.editor.replaceRange(profile.username, view.editor.getCursor())
		}
	}
}
