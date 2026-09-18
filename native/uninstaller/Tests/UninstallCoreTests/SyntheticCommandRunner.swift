// Harness-only lifetime ownership. No Security APIs, process groups, scans or descendant discovery.
import Darwin
import Foundation
import Testing

enum SyntheticCommandError: Error {
    case stopped, timeout, outputLimit, signalDenied(pid_t), terminationUnconfirmed(pid_t), io
}

/// Injected in ordinary tests; live calls target only the Process instance just launched.
func stopSyntheticChild(pid: pid_t, running: () -> Bool,
                        send: (pid_t, Int32) -> Int32,
                        pause: () -> Void = { usleep(20_000) }) throws {
    guard pid > 0 else { throw SyntheticCommandError.terminationUnconfirmed(pid) }
    for signal in [SIGTERM, SIGKILL] {
        if !running() { return }
        let error = send(pid, signal)
        if error != 0 {
            // Even ESRCH is not evidence that Foundation has observed/reaped this child.
            if error == EPERM || error == EACCES { throw SyntheticCommandError.signalDenied(pid) }
            if !running() { return }
            throw SyntheticCommandError.terminationUnconfirmed(pid)
        }
        for _ in 0..<50 {
            if !running() { return }
            pause()
        }
    }
    guard !running() else { throw SyntheticCommandError.terminationUnconfirmed(pid) }
}

final class SyntheticCommandRunner: @unchecked Sendable {
    private let queue = DispatchQueue(label: "caddy.synthetic.child-owner")
    private var active: Process?
    private var stopped = false
    private var timer: DispatchSourceTimer?
    private var signals: [(DispatchSourceSignal, Int32, sig_t?)] = []
    private var last: (pid: pid_t, group: pid_t, confirmed: Bool) = (0, 0, false)
    var observation: (pid: pid_t, group: pid_t, confirmed: Bool) { queue.sync { last } }

    // Constructed only by the opt-in integration/control tests, never ordinary fake suites.
    init(lifetime: Double = 300) {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + lifetime)
        timer.setEventHandler { [weak self] in self?.stopAndExit(124) }
        self.timer = timer
        for number in [SIGINT, SIGTERM] {
            let previous = Darwin.signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: queue)
            source.setEventHandler { [weak self] in self?.stopAndExit(128 + number) }
            signals.append((source, number, previous))
            source.resume()
        }
        timer.resume()
    }

    func finish() {
        queue.sync {
            timer?.cancel()
            for (source, number, previous) in signals {
                source.cancel(); Darwin.signal(number, previous)
            }
            signals.removeAll()
        }
    }

    private func stopChild() throws {
        stopped = true // Never launch another child after any timeout/cancellation/denial.
        guard let child = active else { return }
        try stopSyntheticChild(pid: child.processIdentifier, running: { child.isRunning }, send: { pid, signal in
            Darwin.kill(pid, signal) == 0 ? 0 : errno
        })
        // isRunning=false is Foundation's observation of this exact child's termination.
        child.waitUntilExit()
        last.confirmed = true
        active = nil
    }

    private func stopAndExit(_ code: Int32) {
        do {
            try stopChild()
            fputs("STOP: cancellation/deadline; owned child termination confirmed; fixture outcome uncertain.\n", stderr)
            _exit(code)
        } catch {
            fputs("STOP: owned child termination unconfirmed or denied; no retry; fixture outcome uncertain.\n", stderr)
            if let child = active { fputs("Owned child PID: \(child.processIdentifier)\n", stderr) }
            _exit(126)
        }
    }

    func command(_ executable: String, _ arguments: [String], seconds: Double = 20) throws -> (Int32, Data, Data) {
        let child = Process(), out = Pipe(), err = Pipe()
        child.executableURL = URL(fileURLWithPath: executable)
        child.arguments = arguments
        child.standardInput = FileHandle.nullDevice
        child.standardOutput = out; child.standardError = err
        for handle in [out.fileHandleForReading, err.fileHandleForReading] {
            guard fcntl(handle.fileDescriptor, F_SETFL, O_NONBLOCK) == 0 else { throw SyntheticCommandError.io }
        }
        try queue.sync {
            guard !stopped && active == nil else { throw SyntheticCommandError.stopped }
            // Registration and spawn are serialized against cancellation; no unregistered child window.
            active = child
            do { try child.run() } catch { active = nil; stopped = true; throw error }
            last = (child.processIdentifier, getpgid(child.processIdentifier), false)
        }
        let deadline = ProcessInfo.processInfo.systemUptime + seconds
        var stdout = Data(), stderr = Data()
        do {
            try out.fileHandleForWriting.close(); try err.fileHandleForWriting.close()
            while true {
                try drain(out.fileHandleForReading.fileDescriptor, into: &stdout)
                try drain(err.fileHandleForReading.fileDescriptor, into: &stderr)
                if !child.isRunning { break }
                if ProcessInfo.processInfo.systemUptime >= deadline { throw SyntheticCommandError.timeout }
                usleep(5_000)
            }
            child.waitUntilExit()
            try drain(out.fileHandleForReading.fileDescriptor, into: &stdout)
            try drain(err.fileHandleForReading.fileDescriptor, into: &stderr)
            queue.sync { last.confirmed = true; active = nil }
            return (child.terminationStatus, stdout, stderr)
        } catch {
            try queue.sync { try stopChild() }
            throw error
        }
    }

    private func drain(_ fd: Int32, into data: inout Data) throws {
        var bytes = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = Darwin.read(fd, &bytes, bytes.count)
            if count > 0 {
                guard data.count + count <= 32768 else { throw SyntheticCommandError.outputLimit }
                data.append(contentsOf: bytes.prefix(count))
            } else if count == 0 || errno == EAGAIN { return }
            else if errno != EINTR { throw SyntheticCommandError.io }
        }
    }
}

@Suite("Injected owned-child stop policy")
struct SyntheticChildPolicyTests {
    @Test func denialStopsWithoutAnotherSignal() {
        var signals: [Int32] = []
        #expect(throws: (any Error).self) {
            try stopSyntheticChild(pid: 42, running: { true }, send: { pid, signal in
                #expect(pid == 42); signals.append(signal); return EPERM
            }, pause: {})
        }
        #expect(signals == [SIGTERM])
    }
    @Test(arguments: [pid_t(0), pid_t(-1)])
    func invalidPIDCannotSignalAGroup(pid: pid_t) {
        var sent = false
        #expect(throws: (any Error).self) {
            try stopSyntheticChild(pid: pid, running: { true }, send: { _, _ in sent = true; return 0 }, pause: {})
        }
        #expect(!sent)
    }
    @Test func confirmedExitDoesNotSendKill() throws {
        var alive = true, signals: [Int32] = []
        try stopSyntheticChild(pid: 42, running: { alive }, send: { _, signal in
            signals.append(signal); alive = false; return 0
        }, pause: {})
        #expect(signals == [SIGTERM])
    }
    @Test func unconfirmedExitNeverBecomesSuccess() {
        var signals: [Int32] = []
        #expect(throws: (any Error).self) {
            try stopSyntheticChild(pid: 42, running: { true }, send: { _, signal in
                signals.append(signal); return 0
            }, pause: {})
        }
        #expect(signals == [SIGTERM, SIGKILL])
    }
}

@Suite("Parent ordinary Foundation lifecycle control")
struct SyntheticFoundationControlTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CADDY_HARNESS_CONTROL"] == "parent-control"))
    func directFoundationChildTimeoutIsObserved() throws {
        let runner = SyntheticCommandRunner(lifetime: 10)
        defer { runner.finish() }
        do {
            _ = try runner.command("/bin/sleep", ["30"], seconds: 0.2)
            Issue.record("Control child unexpectedly completed before timeout")
            return
        } catch SyntheticCommandError.timeout { /* Expected, only after exact child exit is confirmed. */ }
        let observed = runner.observation
        try #require(observed.pid > 0 && observed.confirmed)
        do {
            _ = try runner.command("/usr/bin/true", [])
            Issue.record("Stopped runner accepted another child"); return
        } catch SyntheticCommandError.stopped { /* No child was launched. */ }
        print("CONTROL PASS owned Foundation child pid=\(observed.pid) pgid=\(observed.group) runner_pgid=\(getpgrp()) termination_confirmed=true")
    }
}
