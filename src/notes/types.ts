import { Database } from "src/database/database.types"

export class FrontPageError extends Error {
	constructor(message: string) {
		super(message) // Pass the message to the Error constructor
		this.name = "NoFrontPageError" // Set the name of the error
	}
}

export class DatabaseError extends Error {
	constructor(message: string) {
		super(message) // Pass the message to the Error constructor
		this.name = "DatabaseError" // Set the name of the error
	}
}

export type DatabaseNote = Database["public"]["Tables"]["notes"]["Row"]

export type Note = {
	title: string
	path: string
	slug: string
	content: ContentChunk[]
	lead: string
	references: Set<string>
	backreferences: Backreference[]
	properties: NoteProperties
	details: Detail[]
	sidebarImages: SidebarImage[]
}

export type Backreference = {
	displayName: string
	slug: string
}

// TODO: change snake_case for consistency with the related Postgres columns
export type NoteProperties = {
	publish: boolean
	frontpage: boolean
	alt_title: string | undefined
	allowed_users: string[]
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

export type Wikilink = {
	isTransclusion: boolean
	isMedia: boolean
	isBlockRef: boolean
	fullLink: string
	title: string
	header: string | undefined
	altName: string | undefined
}
