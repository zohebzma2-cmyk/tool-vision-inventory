import Foundation
import Capacitor
import UIKit

#if canImport(RoomPlan)
import RoomPlan
#endif

/// Bridges Apple's RoomPlan (LiDAR room capture) to the web layer.
///
/// `isAvailable()` -> { available: Bool }   — false on devices without LiDAR / iOS < 17
/// `scan()`        -> { walls: [...], objects: [...], widthMm, lengthMm, heightMm }
///
/// The scan runs Apple's own capture UI (RoomCaptureView with coaching), so the user gets
/// the familiar walk-around experience, and we return plain JSON the app can turn into a
/// floor plan with real dimensions.
@objc(RoomScanPlugin)
public class RoomScanPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RoomScanPlugin"
    public let jsName = "RoomScan"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise),
    ]

    private var pendingCall: CAPPluginCall?

    @objc func isAvailable(_ call: CAPPluginCall) {
        #if canImport(RoomPlan)
        if #available(iOS 17.0, *) {
            call.resolve(["available": RoomCaptureSession.isSupported])
            return
        }
        #endif
        call.resolve(["available": false])
    }

    @objc func scan(_ call: CAPPluginCall) {
        #if canImport(RoomPlan)
        guard #available(iOS 17.0, *), RoomCaptureSession.isSupported else {
            call.reject("Room scanning needs an iPhone or iPad with LiDAR running iOS 17 or later.")
            return
        }
        pendingCall = call
        call.keepAlive = true
        DispatchQueue.main.async { [weak self] in
            guard let self, let vc = self.bridge?.viewController else {
                call.reject("No view controller available to present the scanner.")
                return
            }
            let scanner = RoomScanViewController()
            scanner.onFinish = { [weak self] result in
                self?.finish(result)
            }
            scanner.modalPresentationStyle = .fullScreen
            vc.present(scanner, animated: true)
        }
        #else
        call.reject("RoomPlan is not available in this build.")
        #endif
    }

    private func finish(_ result: Result<[String: Any], Error>) {
        guard let call = pendingCall else { return }
        pendingCall = nil
        call.keepAlive = false
        switch result {
        case .success(let payload): call.resolve(payload)
        case .failure(let error): call.reject(error.localizedDescription)
        }
    }
}

#if canImport(RoomPlan)
@available(iOS 17.0, *)
final class RoomScanViewController: UIViewController, RoomCaptureViewDelegate, RoomCaptureSessionDelegate {
    var onFinish: ((Result<[String: Any], Error>) -> Void)?

    private var captureView: RoomCaptureView!
    private var finalResults: CapturedRoom?
    private let doneButton = UIButton(type: .system)
    private let cancelButton = UIButton(type: .system)

    override func viewDidLoad() {
        super.viewDidLoad()
        captureView = RoomCaptureView(frame: view.bounds)
        captureView.captureSession.delegate = self
        captureView.delegate = self
        captureView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(captureView)

        configure(doneButton, title: "Done", action: #selector(doneTapped))
        configure(cancelButton, title: "Cancel", action: #selector(cancelTapped))
        NSLayoutConstraint.activate([
            doneButton.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20),
            doneButton.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
            cancelButton.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
            cancelButton.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
        ])
        captureView.captureSession.run(configuration: RoomCaptureSession.Configuration())
    }

    private func configure(_ button: UIButton, title: String, action: Selector) {
        button.setTitle(title, for: .normal)
        button.setTitleColor(.white, for: .normal)
        button.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        button.backgroundColor = UIColor(red: 0.95, green: 0.42, blue: 0.11, alpha: 1) // safety orange
        button.layer.cornerRadius = 22
        button.contentEdgeInsets = UIEdgeInsets(top: 12, left: 24, bottom: 12, right: 24)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.addTarget(self, action: action, for: .touchUpInside)
        view.addSubview(button)
    }

    @objc private func doneTapped() {
        captureView.captureSession.stop()
    }

    @objc private func cancelTapped() {
        captureView.captureSession.stop()
        dismiss(animated: true) { [weak self] in
            self?.onFinish?(.failure(NSError(domain: "RoomScan", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Scan canceled."])))
        }
    }

    // RoomCaptureViewDelegate — hand back the processed room.
    func captureView(didPresent processedResult: CapturedRoom, error: Error?) {
        if let error {
            dismiss(animated: true) { [weak self] in self?.onFinish?(.failure(error)) }
            return
        }
        finalResults = processedResult
        dismiss(animated: true) { [weak self] in
            guard let room = self?.finalResults else { return }
            self?.onFinish?(.success(RoomScanViewController.payload(from: room)))
        }
    }

    func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool {
        error == nil
    }

    /// Flatten a CapturedRoom into plain JSON: wall segments in millimetres plus the
    /// room's overall footprint, which the app turns into a floor plan.
    static func payload(from room: CapturedRoom) -> [String: Any] {
        let mm: (Float) -> Int = { Int(($0 * 1000).rounded()) }

        var minX = Float.greatestFiniteMagnitude, maxX = -Float.greatestFiniteMagnitude
        var minZ = Float.greatestFiniteMagnitude, maxZ = -Float.greatestFiniteMagnitude
        var maxHeight: Float = 0

        let walls: [[String: Any]] = room.walls.map { wall in
            let t = wall.transform
            let cx = t.columns.3.x, cz = t.columns.3.z
            let width = wall.dimensions.x
            let height = wall.dimensions.y
            // Wall direction in the floor plane, from its transform's x-axis.
            let dx = t.columns.0.x, dz = t.columns.0.z
            let hx = dx * width / 2, hz = dz * width / 2
            let x1 = cx - hx, z1 = cz - hz, x2 = cx + hx, z2 = cz + hz
            minX = min(minX, x1, x2); maxX = max(maxX, x1, x2)
            minZ = min(minZ, z1, z2); maxZ = max(maxZ, z1, z2)
            maxHeight = max(maxHeight, height)
            return [
                "x1Mm": mm(x1), "z1Mm": mm(z1),
                "x2Mm": mm(x2), "z2Mm": mm(z2),
                "widthMm": mm(width), "heightMm": mm(height),
            ]
        }

        let objects: [[String: Any]] = room.objects.map { obj in
            let t = obj.transform
            return [
                "category": String(describing: obj.category),
                "xMm": mm(t.columns.3.x),
                "zMm": mm(t.columns.3.z),
                "widthMm": mm(obj.dimensions.x),
                "depthMm": mm(obj.dimensions.z),
                "heightMm": mm(obj.dimensions.y),
            ]
        }

        let footprint: [String: Any] = walls.isEmpty ? [:] : [
            "minXMm": mm(minX), "maxXMm": mm(maxX),
            "minZMm": mm(minZ), "maxZMm": mm(maxZ),
            "widthMm": mm(maxX - minX), "lengthMm": mm(maxZ - minZ),
            "heightMm": mm(maxHeight),
        ]

        return ["walls": walls, "objects": objects, "footprint": footprint]
    }
}
#endif
