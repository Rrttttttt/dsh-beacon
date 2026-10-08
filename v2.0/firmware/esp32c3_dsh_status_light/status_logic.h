#pragma once
#include <stdint.h>
#include <vector>

namespace statuslight {

enum class RetryAction { Wait, Connect, Configure };
struct RetryClock {
  bool active = false;
  uint32_t failureSince = 0;
  uint32_t lastAttempt = 0;
  void attempted(uint32_t now) {
    if (!active) failureSince = now;
    active = true;
    lastAttempt = now;
  }
  void connected() { active = false; }
  RetryAction next(uint32_t now, uint32_t retryMs, uint32_t timeoutMs) const {
    if (!active) return RetryAction::Connect;
    if ((uint32_t)(now - failureSince) >= timeoutMs) return RetryAction::Configure;
    if ((uint32_t)(now - lastAttempt) >= retryMs) return RetryAction::Connect;
    return RetryAction::Wait;
  }
};

template<class Text> Text jsonQuote(const Text &value) {
  const char *hex = "0123456789abcdef";
  Text out = "\"";
  for (unsigned i = 0; i < value.length(); ++i) {
    const unsigned char c = (unsigned char)value[i];
    if (c == '"' || c == '\\') { out += '\\'; out += (char)c; }
    else if (c < 0x20) { out += "\\u00"; out += hex[c >> 4]; out += hex[c & 15]; }
    else out += (char)c;
  }
  out += '"';
  return out;
}

// Configuration selects an SSID, so repeated access points need one entry.
template<class Text, class GetName> Text ssidListJson(int count, GetName nameAt) {
  std::vector<Text> seen;
  Text out = "[";
  for (int i = 0; i < count; ++i) {
    const Text name = nameAt(i);
    if (!name.length()) continue;
    bool duplicate = false;
    for (const auto &previous : seen) if (previous == name) { duplicate = true; break; }
    if (duplicate) continue;
    if (!seen.empty()) out += ',';
    seen.push_back(name);
    out += jsonQuote(name);
  }
  out += ']';
  return out;
}

template<class Text> Text htmlEscape(const Text &value) {
  Text out;
  for (unsigned i = 0; i < value.length(); ++i) {
    switch (value[i]) {
      case '&': out += "&amp;"; break;
      case '<': out += "&lt;"; break;
      case '>': out += "&gt;"; break;
      case '"': out += "&quot;"; break;
      case '\'': out += "&#39;"; break;
      default: out += value[i];
    }
  }
  return out;
}

template<class Text> bool isStateCommand(const Text &value) {
  unsigned n = value.length();
  if (n >= 5 && value[n-5] == '+' && value[n-4] == 'p' && value[n-3] == 'l' && value[n-2] == 'a' && value[n-1] == 'n') n -= 5;
  Text base;
  for (unsigned i = 0; i < n; ++i) base += value[i];
  return base == "off" || base == "idle" || base == "thinking" || base == "think" ||
         base == "busy" || base == "error" || base == "fail" || base == "alarm" ||
         base == "wait" || base == "success" || base == "done" || base == "plan";
}

template<class Text> struct Notification {
  bool active = false;
  uint32_t began = 0;
  Text saved;
  Text after;
  void begin(const Text &current, const Text &target, uint32_t now) {
    if (!active) saved = current;
    after = target;
    began = now;
    active = true;
  }
  bool stateChanged(const Text &next, const Text &current) {
    if (!active || next == current) return false;
    active = false;
    saved = "";
    after = "";
    return true;
  }
  bool complete(uint32_t now, uint32_t duration, Text &target) {
    if (!active || (uint32_t)(now - began) < duration) return false;
    target = after.length() ? after : saved;
    active = false;
    saved = "";
    after = "";
    return true;
  }
};
}
