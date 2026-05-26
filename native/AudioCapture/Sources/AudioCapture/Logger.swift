import Foundation

func logJSON(_ level: String, _ event: String, _ fields: [String: Any] = [:]) {
    var payload: [String: Any] = [
        "level": level,
        "event": event,
        "t": Date().timeIntervalSince1970,
    ]
    for (k, v) in fields {
        payload[k] = v
    }
    if let data = try? JSONSerialization.data(withJSONObject: payload),
        let line = String(data: data, encoding: .utf8)
    {
        FileHandle.standardError.write((line + "\n").data(using: .utf8)!)
    }
}
