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

type Property = {
	name: string
	description: string
	valueType: string
	defaultValue: string
}

const BUILTIN_PROPS: Property[] = [
	{
		name: "wiki-publish",
		description: "Choose whether this page is published or not.",
		valueType: "true/false",
		defaultValue: "true",
	},
	{
		name: "wiki-home",
		description:
			"Set this note as the front page. Can only be set to true on one note.",
		valueType: "true/false",
		defaultValue: "true",
	},
	{
		name: "wiki-title",
		description:
			"Set your page title independently from this note's file name.",
		valueType: "text",
		defaultValue: "",
	},
	{
		name: "wiki-allowed-users",
		description:
			"A list of users who can see this page. It will be hidden to everyone else.",
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
		el.createEl("div", { text: value.name })
		el.createEl("small", { text: value.description }).style.display =
			"block"
		el.createEl("small", { text: `Accepted values: ${value.valueType}` })
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
