export type Note = {
	title: string
	alt_title: string | null
	path: string
	slug: string
	frontpage: string | number
	lead: string
	allowed_users: string | null
}

export type Frontmatter = {
	"wiki-publish": boolean | undefined
	"wiki-title": string | undefined
	"wiki-home": string | undefined
	"wiki-allowed-users": string[] | undefined
}

export type Detail = {
	order: number
	key: string
	value: string | undefined
}

export type SidebarImage = {
	order: number
	image_name: string
	base64: string
	caption: string | undefined
}

export type ContentChunk = {
	chunk_id: number
	text: string
	allowed_users: string[]
}

export type Pages = Map<
	number,
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
