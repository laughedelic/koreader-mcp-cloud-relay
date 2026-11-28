-- Snapshot building and trimming, and sending large snapshots both ways
-- (see run.sh). Needs a local relay.
local socket = require("socket")
local UIManager = require("ui/uimanager")
G_reader_settings = { data = {}, readSetting = function(self, k, d) return d end, saveSetting = function() end, delSetting = function() end, has = function() return false end }
local Snapshot = require("mcp_snapshot")
local cjson = require("cjson")

local page = 50
local doc = { file = "/x/y.pdf" }
function doc:getProps() return { title = "Big", authors = { "A", "B" }, description = string.rep("d", 5000) } end
function doc:getPageCount() return 60 end
function doc:getToc() local t = {} for i = 1, 400 do t[i] = { title = "Chapter " .. i .. " é", page = i, depth = i % 3 + 1 } end return t end
local annotations = {}
for i = 1, 300 do annotations[i] = { text = string.rep("h", 200), note = i % 2 == 0 and "note " .. i or nil, page = i % 60 + 1, datetime = string.format("2026-11-%02d 10:00:%02d", i % 28 + 1, i % 60) } end
annotations[#annotations + 1] = { page = 3, datetime = "2026-01-01 00:00:00" } -- plain bookmark: skipped
local ui = { document = doc, annotation = { annotations = annotations } }
function ui:getCurrentPage() return page end
local options = { scope = "pages", retention_days = 30, page_text = function(n) return string.rep("p" .. n .. " ", 8000) end }

local s = Snapshot.build(ui, options)
assert(#s.pages == 13 and s.pages[1].number == 48 and s.pages[13].number == 60, "window 48..60")
assert(#s.annotations == 300 and s.book.authors == "A, B" and #s.book.description == 2000 and s.book.format == "pdf")
assert(s.position.chapter.index == 50 and s.position.chapter.end_page == 50)
local full = Snapshot.encode(Snapshot.build(ui, options))
print("untrimmed bytes", #full)
local body = Snapshot.encode(s, 262144)
assert(body and #body <= 262144)
local kept = {} for _, p in ipairs(s.pages) do kept[#kept + 1] = p.number end
print("trimmed to", #body, "pages kept:", table.concat(kept, ","), "annotations:", #s.annotations, "toc:", #s.toc)
assert(kept[1] <= 50 and kept[#kept] >= 50, "the current page stays")
-- tighter and tighter
for _, max in ipairs({ 100000, 60000, 20000, 5000, 600 }) do
    local t = Snapshot.build(ui, options)
    local b = Snapshot.encode(t, max)
    print(max, b and #b, "pages", #t.pages, "annotations", #t.annotations, "toc", #t.toc, "desc", t.book.description ~= nil)
    assert(b == nil or #b <= max)
    if b then cjson.decode(b) end
end
assert(Snapshot._clip("héllo", 2) == "h" and Snapshot._clip("héllo", 3) == "hé")
-- no book
assert(Snapshot.build({}, options) == nil)

-- send the big one for real, both ways
local relay = require("mcp_relay"):new()
relay:setRelayUrl(arg[1] or "http://127.0.0.1:8787")
relay:start()
UIManager:run(function() return relay.connected end, 20)
assert(relay.connected)
local got
local t0 = socket.gettime()
relay:detachedDeviceRequest("PUT", "/snapshot", body, function(ok, data, code) got = { ok, data, code } end)
UIManager:run(function() return got end, 30)
print("async PUT", got[1], cjson.encode(got[2]), got[3], string.format("%.2fs", socket.gettime() - t0))
assert(got[1] and got[2].stored == false and got[2].reason == "NO_PAIRED_APPS")
UIManager:run(nil, 16)
got = nil; t0 = socket.gettime()
relay:detachedDeviceRequest("PUT", "/snapshot", body, function(ok, data, code) got = { ok, data, code } end, { blocking = true, timeout = 3 })
print("blocking PUT", got[1], cjson.encode(got[2]), got[3], string.format("%.2fs", socket.gettime() - t0))
assert(got[1])
-- over the relay's limit
got = nil
relay:detachedDeviceRequest("PUT", "/snapshot", full, function(ok, data, code) got = { ok, data, code } end)
UIManager:run(function() return got end, 30)
print("oversized PUT", got[1], got[2], got[3])
assert(got[3] == 413)
-- /bye
got = nil
relay:detachedDeviceRequest("POST", "/bye", "{}", function(ok, data, code) got = { ok, data, code } end, { blocking = true })
print("bye", got[1], cjson.encode(got[2]))
assert(got[1])
relay:stop()
print("ok")
