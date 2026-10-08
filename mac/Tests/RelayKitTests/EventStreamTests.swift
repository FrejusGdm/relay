import Foundation
@testable import RelayKit
import RelayTestSupport
import Testing

@Suite(.timeLimit(.minutes(1)))
struct EventStreamTests {
    @Test func parserFollowsTheServerSentEventsRulesOneByteAtATime() throws {
        let stream = "retry: 1000\r\n\r\n: ping\r\nid: 7\r\nevent: job\r\ndata: line one\r\ndata: line two\r\n\r\n"
            + "id: 8\ndata:x\n\n: ping\n\nevent: worker\rdata: {}\r\r"
        var parser = SSEParser()
        var outputs: [SSEParser.Output] = []
        for byte in Array(stream.utf8) {
            outputs += try parser.feed([byte])
        }
        #expect(outputs == [
            .retry(1000),
            .event(SSEEvent(id: "7", type: "job", data: "line one\nline two")),
            .event(SSEEvent(id: "8", type: "message", data: "x")),
            .event(SSEEvent(id: "8", type: "worker", data: "{}")),
        ])

        var whole = SSEParser()
        #expect(try whole.feed(Array(stream.utf8)) == outputs)
    }

    @Test func eventOver1MiBFails() throws {
        var parser = SSEParser()
        _ = try parser.feed(Array("id: 1\nevent: job\n".utf8))
        let line = Array(("data: " + String(repeating: "x", count: 512 * 1024) + "\n").utf8)
        _ = try parser.feed(line)
        #expect(throws: HTTPError.malformedResponse("An event of the stream is larger than 1 MiB.")) {
            _ = try parser.feed(line)
        }

        var unfinished = SSEParser()
        #expect(throws: HTTPError.malformedResponse("An event of the stream is larger than 1 MiB.")) {
            _ = try unfinished.feed(Array(("data: " + String(repeating: "x", count: 1024 * 1024)).utf8))
        }
    }

    @Test func longStreamIsDeliveredEventByEvent() async throws {
        let fake = try FakeDaemon()
        defer { fake.stop() }
        let feed = EventFeed()
        fake.reply("GET", "/v1/events", with: .feed(feed))
        let clock = FixedClock()
        let client = DaemonClient(location: fake.location, clock: clock)
        var events = client.events(lastEventID: nil).makeAsyncIterator()

        feed.push("retry: 1000\n\n")
        #expect(try await events.next()?.payload == .retry(milliseconds: 1000))

        let job = try Fixtures.text("api/events/job.json").replacingOccurrences(of: "\n", with: "")
        let expectedJob = try APIDecoder.decode(Job.self, from: Array(job.utf8))
        var id = 0
        var sent = 0
        for _ in 0..<40 {
            feed.push(": ping\n\n")
            clock.advance(by: 15)
            var chunk = ""
            for _ in 0..<300 {
                id += 1
                chunk += "id: \(id)\nevent: job\ndata: \(job)\n\n"
            }
            sent += chunk.utf8.count
            feed.push(chunk)
            for expected in (id - 299)...id {
                let event = try #require(try await events.next())
                #expect(event.id == expected)
                #expect(event.payload == .job(expectedJob))
            }
        }
        #expect(sent > 5 * 1024 * 1024)
        feed.close()
        #expect(try await events.next() == nil)
    }

    @Test func fortyFiveSecondsWithoutBytesEndTheStream() async throws {
        let fake = try FakeDaemon()
        defer { fake.stop() }
        let feed = EventFeed()
        fake.reply("GET", "/v1/events", with: .feed(feed))
        let clock = FixedClock()
        let client = DaemonClient(location: fake.location, clock: clock)
        var events = client.events(lastEventID: nil).makeAsyncIterator()

        feed.push("retry: 1000\n\n")
        #expect(try await events.next()?.payload == .retry(milliseconds: 1000))
        clock.advance(by: 44)
        feed.push("id: 1\nevent: reset\ndata: {}\n\n")
        #expect(try await events.next() == ServerEvent(id: 1, payload: .reset))
        clock.advance(by: 46)
        var failure: Error?
        do {
            while try await events.next() != nil {}
        } catch {
            failure = error
        }
        #expect(failure as? HTTPError == .timedOut)
    }

    @Test func availabilityDecodesInBothShapes() throws {
        let account = try Fixtures.text("api/events/availability.json").replacingOccurrences(of: "\n", with: "")
        let fromAccount = ServerEvent(.event(SSEEvent(id: "4181", type: "availability", data: account)))
        guard case .availability(let change) = fromAccount.payload else {
            Issue.record("Expected an availability event, got \(fromAccount.payload)")
            return
        }
        #expect(fromAccount.id == 4181)
        #expect(change.target == "claude:work")
        #expect(change.availability.status == .rateLimited)
        #expect(change.usage == [])

        let short = #"{"target":"claude:work","availability":{"status":"rate_limited","reason":"Claude Code reported a rate limit","retry_at":null,"measured_at":"2026-10-07T14:02:11.402Z","source":"hook"}}"#
        let fromShort = ServerEvent(.event(SSEEvent(id: "4182", type: "availability", data: short)))
        guard case .availability(let shortChange) = fromShort.payload else {
            Issue.record("Expected an availability event, got \(fromShort.payload)")
            return
        }
        #expect(shortChange.target == "claude:work")
        #expect(shortChange.availability == change.availability)
        #expect(shortChange.usage == nil)
    }

    @Test func otherEventTypesAreDecodedOrSkipped() throws {
        let worker = try Fixtures.text("api/events/worker.json").replacingOccurrences(of: "\n", with: "")
        let checkpoint = try Fixtures.text("api/events/checkpoint.json").replacingOccurrences(of: "\n", with: "")
        let stream = "id: 1\nevent: worker\ndata: \(worker)\n\nid: 2\nevent: checkpoint\ndata: \(checkpoint)\n\n"
            + "id: 3\nevent: hook\ndata: {\"job_id\":\"3f9a2c1d\"}\n\nid: 4\nevent: lineage\ndata: {}\n\n"
            + "id: 5\nevent: reset\ndata: {}\n\nid: 6\nevent: shutdown\ndata: {}\n\n"
        var parser = SSEParser()
        let events = try parser.feed(Array(stream.utf8)).map(ServerEvent.init)
        #expect(events.map(\.id) == [1, 2, 3, 4, 5, 6])
        guard case .worker(let decoded) = events[0].payload, case .checkpoint(let change) = events[1].payload else {
            Issue.record("Expected a worker and a checkpoint event")
            return
        }
        #expect(decoded.id == "5d2e8f01")
        #expect(change.checkpoint.number == 7)
        #expect(events[2].payload == .ignored(type: "hook"))
        #expect(events[3].payload == .ignored(type: "lineage"))
        #expect(events[4].payload == .reset)
        #expect(events[5].payload == .shutdown)
    }

    @Test func streamRequestCarriesLastEventIDAndAccept() async throws {
        let fake = try FakeDaemon()
        defer { fake.stop() }
        let feed = EventFeed()
        feed.close()
        fake.reply("GET", "/v1/events", with: .feed(feed))
        let client = DaemonClient(location: fake.location)

        for try await _ in client.events(lastEventID: 4180) {}
        for try await _ in client.events(lastEventID: nil) {}

        let requests = fake.requests
        #expect(requests.count == 2)
        #expect(requests.allSatisfy { $0.path == "/v1/events" && $0.headers["accept"] == "text/event-stream" })
        #expect(requests[0].headers["last-event-id"] == "4180")
        #expect(requests[1].headers["last-event-id"] == nil)
        #expect(requests.allSatisfy { $0.headers["origin"] == nil })
    }
}
