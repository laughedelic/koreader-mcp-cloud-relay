local socket = require("socket")
local M = { tasks = {} }
function M:scheduleIn(delay, fn) table.insert(self.tasks, { at = socket.gettime() + delay, fn = fn }) end
function M:nextTick(fn) self:scheduleIn(0, fn) end
function M:unschedule(fn) for i = #self.tasks, 1, -1 do if self.tasks[i].fn == fn then table.remove(self.tasks, i) end end end
function M:show() end
function M:close() end
-- Run scheduled tasks until `done()` is true or `timeout` seconds pass
function M:run(done, timeout)
  local deadline = socket.gettime() + (timeout or 30)
  while socket.gettime() < deadline do
    if done and done() then return true end
    local now = socket.gettime()
    local due = {}
    for i = #self.tasks, 1, -1 do if self.tasks[i].at <= now then table.insert(due, 1, table.remove(self.tasks, i)) end end
    for _, task in ipairs(due) do task.fn() end
    socket.sleep(0.02)
  end
  return done == nil
end
return M
