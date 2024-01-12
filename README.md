# Wiki Generator

The Wiki Generator is an [Obsidian](https://obsidian.md/) plugin designed to make it easy and convenient to publish your notes online for the whole world to see (or just your friends), while allowing you to keep working on Obsidian without having to touch any sort of code - unless you want to!

*How does it work?* In short, the Wiki Generator takes notes and files from your local vault and converts them into a web-friendly format. It also handles special format tags that you can use to modify how each page looks before it reaches the web. Then, it uploads them to your own remote database and finally instructs your website to update using all of your new content. Your changes are applied in less than a minute or two.

*Want an example?* [This plugin's documentation](https://wiki-generator-documentation.vercel.app/) is entirely published using the Wiki Generator.

To begin, add this plugin to your vault and follow the [Getting started](https://wiki-generator-documentation.vercel.app/getting-started) guide in the documentation.

### Installation

This plugin is still early in development and is not yet available as an official Obsidian plugin that you can discover from the third-party plugin tab. As such, you will need to do a manual installation. To do so, make sure you have `npm` installed on your system. Then, follow these steps:

1. Clone this repository in the `.obsidian/plugins` folder of whichever vault you want to use it in. You may have to show hidden folders, depending on what operating system and file explorer you're using.
2. Open a terminal in that folder and run `npm install`.
3. Once it finishes installing all the dependencies, run `npm run build`.
4. Restart Obsidian if it was open.

If you see the Wiki Generator tab in your settings, the plugin is now up and running.

### License

This project is licensed under the GNU GPLv3 license.