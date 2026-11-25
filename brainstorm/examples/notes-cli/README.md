# notes-cli

A tiny command-line notebook. Notes live in one JSON file (`NOTES_FILE`, or
`notes.json` in the current folder).

    node src/cli.js add "buy cat food"
    node src/cli.js list
    node src/cli.js done 2
    node src/cli.js delete 2
    node --test

The file format is version 1: `{ "version": 1, "notes": [{ "id", "text", "created", "done" }] }`.
People already have notes files in this format, and other scripts read them.
