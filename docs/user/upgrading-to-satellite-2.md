# Upgrading to Satellite 2

On its first launch, Satellite 2 copies your Satellite 1.x database and upgrades the copy, the same
way T3 Code brings threads forward from older versions. Read
[Threads from older T3 Code versions](./thread-migration.md) for how threads and transcripts carry
over. You do not need to run anything. A remote environment upgrades its own database the first
time its server starts.

## What is kept

- Every work thread, with its title, project, and transcript, and its archive, pin, and snooze state.
- Issue board connections, and the links from tickets to the threads and worktrees started from them.

## What moves to the archive

Idea threads and Revdoc 1.x background test threads move to the thread archive, so they no longer
fill the sidebar. You can still read them there, and unarchive any you want back. An unarchived
thread stays unarchived. Threads you had already archived or deleted keep that state.

## What is removed

Satellite 2 does not carry Idea notebooks, Documents and manual reviews with their history, Open
work folder links and favourites, commit recommendations, or delivery of issue updates between
environments. Their data is not copied into Satellite 2.

## Getting old data back

Satellite 2 never changes your 1.x database. `state.sqlite` stays in your Satellite data folder
(`~/.satellite-t3/userdata` for the installed app) beside the new `statev2.sqlite`. To read an old
notebook or document, open Satellite 1.x, which keeps using `state.sqlite`. The copy happens once:
work you do in 1.x after upgrading does not appear in Satellite 2.

If you ran a Satellite development build that already created `statev2.sqlite`, Satellite 2
upgrades that file in place and keeps the threads you created on that build. It does not copy
`state.sqlite` again.
