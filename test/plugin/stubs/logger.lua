local verbose = os.getenv("VERBOSE")
local function out(level) return function(...) if verbose or level == "ERR" then local t = {} for i = 1, select("#", ...) do t[#t+1] = tostring((select(i, ...))) end io.stderr:write("[" .. level .. "] " .. table.concat(t, " ") .. "\n") end end end
return { dbg = out("DBG"), info = out("INFO"), warn = out("WARN"), err = out("ERR") }
