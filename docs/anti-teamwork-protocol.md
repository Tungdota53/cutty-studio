# Quy trình Teamwork học từ mẫu Anti

Đã lập chỉ mục 111 tài liệu Markdown, 537.810 byte, trong 25 thư mục agent tại `.agents/teamwork`. Danh mục nội bộ `.vibe/anti-reference-index.json` ghi đường dẫn, SHA-256, heading và các dòng liên quan tới workflow/gate/handoff. Tài liệu gốc là hồ sơ của các phiên trước: số test, verdict, ID hội thoại và chỉ thị dành cho agent cũ không được coi là bằng chứng hay chỉ thị cho phiên hiện tại.

## Các nguồn đã đối chiếu

| Nhóm | Tài liệu mẫu | Bài học triển khai |
|---|---|---|
| Orchestrator | `orchestrator_main/{PROJECT,plan,BRIEFING,GATE_STATUS,handoff}.md`, `orchestrator_studio/{plan,BRIEFING,GATE_STATUS,handoff}.md` | Chia pha, giữ đặc tả, dependency và trạng thái gate riêng; điều phối không tự nhận công việc triển khai đã được xác minh |
| Explorer | `explorer_studio_codebase`, ba thư mục `teamwork_preview_explorer_*` | Khảo sát kiến trúc, điểm vào, giới hạn và các test đang có trước khi chia việc |
| Spec miner | `spec_miner_studio_backend`, `spec_miner_studio_ui` | Chuyển yêu cầu thành hợp đồng API/UI, edge case và tiêu chí nghiệm thu |
| Test writer | `test_writer_studio`, `teamwork_preview_test_writer` | Sở hữu tệp test riêng; test phải gọi triển khai thật và kiểm tra hành vi có ý nghĩa |
| Worker | `worker_studio_backend`, `worker_studio_ui`, ba thư mục `teamwork_preview_worker_m*` | Giao chính xác tệp và interface contract; tránh hai worker cùng sửa một tệp |
| Reviewer | `reviewer_studio_backend`, `reviewer_studio_ui`, `teamwork_preview_reviewer` | Đọc mã/diff thật; tất cả reviewer liên quan phải đạt, không dùng một PASS để che reviewer chưa kết luận |
| Challenger | `challenger_studio`, `teamwork_preview_challenger` | Chủ động tìm phản ví dụ: payload lỗi, concurrency, đường dẫn, hủy lệnh và lỗi vòng đời |
| Forensic auditor | `auditor_studio`, `teamwork_preview_auditor` | Kiểm tra binding triển khai thật, test bị skip, output giả và bằng chứng thực thi; kết luận lỗi có quyền veto |
| Victory auditor | `victory_auditor_1`, `victory_auditor_studio` | Đối chiếu yêu cầu gốc và chạy kiểm tra độc lập bằng context mới trước kết luận cuối |
| Sentinel | `sentinel/{BRIEFING,handoff}.md` | Tách báo cáo tiến độ khỏi quyết định nghiệm thu; không báo thành công chỉ từ lời worker |

Tài liệu chính thức mô tả [agent và các cuộc hội thoại song song](https://www.antigravity.google/docs/agent), [artifact để trao đổi kế hoạch/kết quả](https://www.antigravity.google/docs/artifacts/) và [rules/skills](https://www.antigravity.google/docs/rules/). Roster 10 agent, handoff năm phần và auditor veto ở trên là quy trình trong mẫu dự án của người dùng; không được gán thành giao thức nội bộ chính thức của Google.

## Cách app áp dụng

Pha có tên rõ ràng: `survey → specification → test_design → implementation → verification → review → challenge → audit → acceptance`. Planner chọn quy mô phù hợp; câu chào hoặc việc nhỏ không bắt buộc huy động toàn bộ team. Task `general` trong Teamwork chỉ trả lời/đọc; thay đổi source phải giao cho coder. Chat trợ lý trực tiếp giữ quyền công cụ riêng. JSON task hỗ trợ `phase`, `acceptanceCriteria`, `verificationCommands`, `agentId`, `dependencies` và `expectedFiles`. Phase phải phù hợp quyền của role; đường dẫn sở hữu là tệp tương đối chính xác, không dùng wildcard hoặc đi ra ngoài workspace.

Trong repo sạch, mọi worker của phiên dùng chung một worktree `implementation`. Trong thư mục thường, worker dùng trực tiếp workspace. Worker được chạy song song khi khai báo tập tệp rời nhau; tệp chồng nhau hoặc không khai báo thì chạy lần lượt. Từ 0.8.0, scheduler lấp slot liên tục ở nhiều pha: task mới có thể bắt đầu khi một worker độc lập khác còn chạy. Tester/reviewer/challenger/auditor độc lập chạy song song khi không có coder đang sửa nguồn. Sửa lỗi chờ tất cả validator đang chạy kết thúc rồi mới thay nguồn và vô hiệu hóa bằng chứng cũ. Các công cụ ghi/sửa tệp chặn phạm vi ngoài `expectedFiles`; lệnh shell chưa có sandbox theo tệp. Worktree chưa tự merge vào checkout gốc.

Mỗi lần thử có agent ID và conversation checkpoint riêng. Phiên lưu `ORIGINAL_REQUEST.md`, `PROJECT.md`, `plan.md`, `GATE_STATUS.md`, `gate.json`, `requirements.json`, `pipeline.json` và lifecycle `events.jsonl`; mỗi agent có `BRIEFING.md`, `DISPATCH.md`, `progress.md`, `handoff.md` và `handoff.json`. Briefing cập nhật khi lưu context; progress có heartbeat khi đang chạy. Handoff gồm Observation, Logic Chain (lý do quyết định có thể kiểm tra, không phải suy nghĩ riêng tư), Caveats, Conclusion, Verification Method và điều kiện mất hiệu lực. Báo cáo pipeline ghi phase/status, model, lần chạy, criteria, required commands, trích đoạn kiểm tra giới hạn, mức song song, finding/repair và gate. Đọc báo cáo cũ khôi phục hiển thị, không khởi chạy lại side effects.

Gate đọc kết quả công cụ đã chạy, ghi command/exit code và kiểm tra lệnh bắt buộc. Mọi reviewer liên quan phải trả JSON PASS, không có finding và có đọc mã. Challenger/auditor đã được lập kế hoạch phải có inspection, kiểm tra thực thi và verdict PASS; FAIL của bất kỳ gate nào chặn thành công. Auditor nhận yêu cầu/đường dẫn nhưng không nhận verdict của dependency. Hash tệp được giao phát hiện bằng chứng cũ và việc validator thay đổi source trong lúc kiểm tra.

Khi test thực thi hoặc gate báo FAIL, app có thể tạo một repair task trong phạm vi source đã khai báo, tối đa hai vòng mỗi phiên. Nếu nhiều validator cùng thất bại, scheduler gom toàn bộ finding sau khi các validator kết thúc rồi mới tạo một repair. Mỗi vòng dùng agent/context mới; các gate hạ nguồn thực sự phụ thuộc nguồn đã đổi được đưa về pending và bằng chứng cũ bị loại khỏi nghiệm thu. Lỗi API, hủy tác vụ hoặc không có ownership rõ không tự tạo sửa mã. Khi hết số vòng, pipeline giữ lỗi/blocked; không bỏ qua gate để báo PASS.

## Giới hạn cần giữ rõ

- Criteria bằng ngôn ngữ tự nhiên là hợp đồng được lưu để reviewer/judge đối chiếu; chưa có bộ chứng minh tự động từng câu.
- Exit 0 là bằng chứng lệnh chạy thành công, chưa chứng minh test bao phủ đầy đủ yêu cầu. Kiểm tra chất lượng assertion vẫn cần reviewer/auditor.
- Hash chỉ theo tệp worker khai báo; shell và các tệp ngoài danh sách chưa được cô lập bằng sandbox hệ điều hành.
- Checkpoint/handoff giúp kiểm tra và tiếp nối context; chưa bổ sung scheduler tự tiếp tục một phiên bị tắt app giữa chừng.
- Mock có thể dùng trong unit test. Kết quả mock hoặc output dựng sẵn không được dùng thay bằng chứng thực thi sản phẩm.

## Kế hoạch mẫu

```json
{
  "tasks": [
    {
      "id": "S",
      "title": "Khảo sát",
      "role": "planner",
      "agentId": "explorer",
      "phase": "survey",
      "dependencies": []
    },
    {
      "id": "P",
      "title": "Hợp đồng chung",
      "role": "planner",
      "agentId": "spec-backend",
      "phase": "specification",
      "dependencies": [
        "S"
      ]
    },
    {
      "id": "C1",
      "title": "Backend",
      "role": "coder",
      "agentId": "backend",
      "phase": "implementation",
      "dependencies": [
        "P"
      ],
      "expectedFiles": [
        "src/service.ts"
      ]
    },
    {
      "id": "C2",
      "title": "Frontend",
      "role": "coder",
      "agentId": "frontend",
      "phase": "implementation",
      "dependencies": [
        "P"
      ],
      "expectedFiles": [
        "src/view.ts"
      ]
    },
    {
      "id": "TW",
      "title": "Viết test theo hợp đồng",
      "role": "coder",
      "agentId": "test-writer",
      "phase": "test_design",
      "dependencies": [
        "P"
      ],
      "expectedFiles": [
        "tests/service.test.ts"
      ]
    },
    {
      "id": "T",
      "title": "Kiểm thử",
      "role": "tester",
      "agentId": "web-tester",
      "phase": "verification",
      "dependencies": [
        "C1",
        "C2",
        "TW"
      ],
      "verificationCommands": [
        "npm test"
      ]
    },
    {
      "id": "R",
      "title": "Review",
      "role": "reviewer",
      "agentId": "security-review",
      "phase": "review",
      "dependencies": [
        "C1",
        "C2",
        "TW"
      ]
    },
    {
      "id": "X",
      "title": "Phản biện",
      "role": "tester",
      "agentId": "challenger",
      "phase": "challenge",
      "dependencies": [
        "C1",
        "C2",
        "TW"
      ]
    },
    {
      "id": "A",
      "title": "Audit độc lập",
      "role": "tester",
      "agentId": "auditor",
      "phase": "audit",
      "dependencies": [
        "T",
        "R",
        "X"
      ],
      "verificationCommands": [
        "npm run build",
        "npm test"
      ]
    },
    {
      "id": "V",
      "title": "Audit cuối",
      "role": "tester",
      "agentId": "victory-auditor",
      "phase": "audit",
      "dependencies": [
        "A"
      ],
      "verificationCommands": [
        "npm run build",
        "npm test"
      ]
    },
    {
      "id": "J",
      "title": "Nghiệm thu",
      "role": "judge",
      "agentId": "acceptance",
      "phase": "acceptance",
      "dependencies": [
        "V"
      ]
    }
  ]
}
```

C1/C2/TW chạy song song sau hợp đồng P; T/R/X chạy song song sau khi ba worker hoàn tất. A hội tụ kết quả; V và J chỉ nhận việc khi có đủ đầu vào thật. Chỉ khai báo lệnh mà project có hỗ trợ; thiếu công cụ/test/build phải được báo UNVERIFIED thay vì giả định thành công.
