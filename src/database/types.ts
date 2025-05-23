import { Vault } from "obsidian"
import { WikiGeneratorSettings } from "src/settings"

export type Note = {
	title: string
	alt_title: string | null
	search_terms: string
	path: string
	slug: string
	frontpage: string | number // actually boolean but SQLite is jank
	lead: string
	allowed_users: string | null
	hash: string
	last_updated: number
	can_prerender: number // actually boolean but SQLite is jank
}

export type Frontmatter = {
	"wiki-publish": boolean | undefined
	"wiki-title": string | undefined
	"wiki-home": string | undefined
	"wiki-allowed-users": string[] | undefined
} & Record<string, any>

export type Detail = {
	order: number
	key: string
	value: string | null
}

export type SidebarImage = {
	order: number
	image_name: string
	image_path: string
	caption: string | null
}

export type ContentChunk = {
	chunk_id: number
	text: string
	allowed_users: string | null
	image_path: string | null
	note_transclusion_path: string | null
}

export type Image = {
	path: string
	blob?: Uint8Array | null
	svg_text: string | null
	alt: string | null
	hash: string
	last_updated: number
	compressed: number // actually boolean but SQLite is jank
}

export type ImageData = {
	path: string
	hash: string
}

export type Pages = Map<
	string,
	{
		note: Note
		chunks: ContentChunk[]
		details: Detail[]
		sidebarImages: SidebarImage[]
	}
>

export type User = {
	id: number
	username: string
	password: string
}

export interface DatabaseAdapter {
	remote: boolean
	runMigrations(): Promise<void>

	insertUsers(users: User[]): Promise<void>

	getImageData(): Promise<ImageData[]>
	insertImages(
		images: {
			path: string
			alt: string
			hash: string
			buf: ArrayBuffer | null
			svg_text: string | null
		}[]
	): Promise<string[]>
	deleteImagesByPath(paths: string[]): Promise<number>

	getNotes(): Promise<Note[]>
	insertPages(pages: Pages): Promise<number>
	deleteNotesByPath(paths: string[]): Promise<number>

	updateSettings(settings: WikiGeneratorSettings): Promise<void>
	clearContent(): Promise<void>
	export(vault: Vault): Promise<void>
	close(): Promise<void>
}
