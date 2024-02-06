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

export type Note = {
	title: string
	path: string
	slug: string
	content: string
	references: Set<string>
	backreferences: Backreference[]
	properties: NoteProperties
	details: Map<string, string>
	sidebarImages: SidebarImage[]
}

export type Backreference = {
	displayName: string
	slug: string
}

// TODO: change snake_case to camelCase for consistency
export type NoteProperties = {
	publish: boolean
	frontpage: boolean
	alt_title: string | undefined
	allowed_users: string[]
}

export type SidebarImage = {
	image_name: string
	url: string | undefined
	caption: string | undefined
}

export type ContentChunk = {
	chunk_id: number,
	chunk: string,
	allowedUsers: string[],
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