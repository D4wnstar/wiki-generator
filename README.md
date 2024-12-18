# Wiki Generator

The Wiki Generator is an [Obsidian](https://obsidian.md/) plugin designed to make it convenient to publish your notes online for others to see, while still allowing you to do all of your writing in Obsidian.

*How does it work?* In short, the Wiki Generator takes notes and files from your Obsidian vault and converts them into a format a website can use. It also handles special syntax that you can use to customize how your notes are displayed on the web. Then, it uploads your notes to your website, which you can get a copy of in a minute or two. Your website automatically updates to reflect these changes. Once you set things up, you only need to press a single button to sync your website with your vault.

*Want an example?* [This plugin's documentation](https://wiki-generator-documentation.vercel.app/) is entirely published using the Wiki Generator.

To begin, add this plugin to your vault and follow the [Getting started](https://wiki-generator-documentation.vercel.app/getting-started) guide in the documentation.

## Features
- It's free!
- Fine-grained control over what you publish - make only what you want public
- Optional user accounts allow you to make content visible only to certain users
- Make your writing public without leaving the comfort of your Obsidian vault

## Installation
This plugin is still early in development and is not currently available as an official Obsidian plugin. As such, you can't find it in the plugin search within Obsidian; you will need to do a manual installation. To do so, you'll need `npm` installed on your system. Then, follow these steps:

1. Clone this repository in the `.obsidian/plugins` folder of whichever vault you want to use it in. You may have to show hidden folders if you are on MacOS or Linux.
2. Open a terminal in that folder and run `npm install`.
3. Once it finishes installing everything, run `npm run build`.
4. Restart Obsidian if it was open.

If you see the Wiki Generator tab in your settings, the plugin is now up and running. Follow the [Getting started](https://wiki-generator-documentation.vercel.app/getting-started) guide to set everything up.

## License

This project is licensed under the Apache 2.0 license.