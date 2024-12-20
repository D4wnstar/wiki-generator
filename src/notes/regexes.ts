export const secretBlockRegex = /^:::secret\s*\((.*?)\)\n(.*?)\n:::/gms
export const secretBlockRegexNoGroups = /^:::secret\s*\(.*?\)\n.*?\n:::/gms
export const transclusionRegex = /!\[\[(.*?)(#\^?.*?)?(\|.*?)?\]\]/g
export const transclusionRegexNoGroups = /!\[\[.*?(?:#\^?.*?)?(?:\|.*?)?\]\]/g
export const propsRegex = /^---\n+(.*?)\n+---/s
