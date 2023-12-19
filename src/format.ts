import { Converter } from "showdown";
import slugify from 'slugify'
import { Vault } from "obsidian";
import { writeFileSync } from "fs";
import { join } from "path";

type Note = {
    title: string
    path: string
    slug: string
    content: string
    references: Set<string>
    backreferences: Backreference[]
    properties: NoteProperties
}

type Backreference = {
    displayName: string
    slug: string
}

type NoteProperties = {
    publish: boolean
    frontpage: boolean
}

function slugifyPath(path:string): string {
    const elems = path.split("/").filter(elem => elem !== "")
    const slugged = []
    for (const elem of elems) {
        slugged.push(slugify(elem, {lower: true, remove: /[^\w\d\s]/g}))
    }

    return slugged.join("/")
}

function parseProperties(match: string): NoteProperties {
    const props: NoteProperties = { publish: false, frontpage: false }
    const propsLines = match.split("\n")
    for (const line of propsLines) {
        const kv = line.split(": ")
        switch (kv[0]) {
            case "dg-publish":
                if (kv[1] === "true") { props.publish = true }
                break;
            case "dg-home":
                if (kv[1] === "true") { props.frontpage = true }
            default:
                break;
        }
    }
    return props
}

function formatMd(md: string): [string, NoteProperties] {
    const propsRegex = /^---\r?\n(.*?)\r?\n---/s
    const match = md.match(propsRegex)
    let props: NoteProperties = { publish: false, frontpage: false }
    if (match) {
        props = parseProperties(match[1]) // Save some properties before removing them
        md = md.replace(propsRegex, "") // Remove obsidian properties
    }
    md = md.replace(/^:::hidden\n.*?\n:::/gms, "") // Remove :::hidden::: blocks
    md = md.replace(/^#+ GM.*?(?=^#|$(?![\r\n]))/gms, "") // Remove GM paragraphs
    return [md, props]
}

function backrefAlreadyExists(displayName: string, slug: string, backrefs: Backreference[]): boolean {
    for (const backref of backrefs) {
        if (backref.displayName === displayName && backref.slug === slug) {
            return true
        }
    }

    return false
}

function convertWikilinks(note: Note, notes: Note[]): Note {
    note.content = note.content.replace(/\[\[(.*?)(?:\|(.*?)?)?\]\]/g, (match, ...groups) => {
        const captureGroups: string[] = groups.slice(0, -2)
        const realName = captureGroups[0]
        const altName = captureGroups.length > 1 ? captureGroups[1] : undefined
        // Check if the path is explicit (like [[Enciclopedia Antediluviana/Nazioni/Auriga]])
        // or implicit (like [[Auriga]]). If it's implicit, the note name is unique.
        const refNote = realName.split("/").filter(elem => elem !== "").length > 1
                        ? notes.find((note) => note.slug === slugifyPath(realName))
                        : notes.find((note) => note.title.toLowerCase() === realName.toLowerCase())

        if (refNote) {
            if (!backrefAlreadyExists(note.title, note.slug, refNote.backreferences)) {
                refNote.backreferences.push({ displayName: note.title, slug: note.slug })
            }
        }
        else {
            console.warn(`Could not find note "${realName}"`)
            return altName ? altName : realName
        }

        note.references.add(refNote.slug)
        return `<a href="/${refNote.slug}" class="anchor">${altName ? altName : realName}</a>`
    })

    return note
}

async function readNotes(converter: Converter, vault: Vault): Promise<Note[]> {
    const notes: Note[] = []
    const mdFiles = vault.getMarkdownFiles();

    for (const file of mdFiles) {
        const slug = slugifyPath(file.path.replace(".md", ""))

        let content = await vault.read(file);
        const out = formatMd(content)
        content = out[0]
        const props = out[1]

        let html = converter.makeHtml(content)
        html = html.replace(/<h(\d)(.*?)>(.*?)<\/h\d>/g, '<h$1$2 class="h$1">$3</h$1>')
        html = html.replace(/<a(.*?)>(.*?)<\/a>/g, '<a$1 class="anchor" target="_blank">$2</a>')
        html = html.replace(/<blockquote>/g, '<blockquote class="blockquote">')
        html = html.replace(/<ul>/g, '<ul class="list-disc list-inside [&_&]:pl-5">')
        html = html.replace(/<ol>/g, '<ul class="list-decimal list-inside [&_&]:pl-5">')

        notes.push({
            title: file.name.replace(".md", ""),
            path: file.path.replace(".md", ""),
            slug: slug,
            content: html,
            references: new Set<string>(),
            backreferences: [],
            properties: props
        })
    }
    return notes
}

function noteToString(note: Note): string {
    let out = ""
    out += "{"
    out += `\n\t\ttitle: "${note.title}",`
    out += `\n\t\tpath: "${note.path}",`
    out += `\n\t\tslug: "${note.slug}",`
    out += `\n\t\treferences: [`
    for (const ref of note.references) {
        out += `"${ref}", `
    }
    out += `],`
    out += `\n\t\tbackreferences: [`
    for (const ref of note.backreferences) {
        out += `{displayName: "${ref.displayName}", slug: "${ref.slug}"}, `
    }
    out += `],`
    out += `\n\t\tcontent: \`${note.content}\`,`
    out += `\n\t\tproperties: { publish: ${note.properties.publish}, frontpage: ${note.properties.frontpage} },`
    out += "\n\t}"

    return out
}

export async function convertNotesForUpload(vault: Vault, outPath: string): Promise<void> {
    const converter = new Converter()
    let notes = await readNotes(converter, vault);
    notes = notes.map((note) => convertWikilinks(note, notes))
    notes.sort((a, b) => a.slug.localeCompare(b.slug));

    let notesJsonString = ""
    const frontpage = notes.find(note => note.properties.frontpage)
    if (frontpage) {   
        notesJsonString += "export const frontpage = "
        notesJsonString += noteToString(frontpage)
        notesJsonString += "\n"
    }
    
    notesJsonString += "export const notes = [\n"
    for (const note of notes) {
        if (!note.properties.publish || note.properties.frontpage) { continue }
        notesJsonString += "\t"
        notesJsonString += noteToString(note)
        notesJsonString += ",\n"
    }
    notesJsonString += "]"
    
    writeFileSync(join(outPath, "notes-data.ts"), notesJsonString, { encoding: "utf-8" })
}
