# fastwebconn

fastwebconn solves problems with 429 errors caused by WebTorrent making a seperate range request to a webseed endpoint for each chunk, including optization of chunk ranges when seeking in a stream is detected.

It is intended as a drop-in replacement for webtorrent/lib/webconn.js

### Why this is needed

Satellite nodes use webtorrent to distribute large blobs amongst nodes. When there are peers online, each node that is downloading a blob is able to download chunks from different nodes in a paralell, distrubuting the requests across all the peers it's able to connect to. However, if there are no peers online, WebTorrent's default behaviour is to look for a webseed that has the entire file and request each chunk in as a series of range requests. This often leads to the server sending back a 429 errors because it's getting hit with a large number of requests one after the other. By intelligently grouping adjacent chunks into larger range requests, fastwebconn allows clients to make use of http webseeds without running into this issue.
