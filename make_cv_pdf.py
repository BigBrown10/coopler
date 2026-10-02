"""Generate an ATS-friendly cv.pdf for Osamudiamen Edogun (product-manager framing)."""
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, HRFlowable)

ACCENT = HexColor("#1a3a5c")
GREY = HexColor("#555555")

name = ParagraphStyle("name", fontName="Helvetica-Bold", fontSize=20, textColor=ACCENT, spaceAfter=2)
contact = ParagraphStyle("contact", fontName="Helvetica", fontSize=9, textColor=GREY, spaceAfter=8)
h2 = ParagraphStyle("h2", fontName="Helvetica-Bold", fontSize=12, textColor=ACCENT, spaceBefore=10, spaceAfter=3)
role = ParagraphStyle("role", fontName="Helvetica-Bold", fontSize=10.5, spaceBefore=6, spaceAfter=1)
meta = ParagraphStyle("meta", fontName="Helvetica-Oblique", fontSize=9, textColor=GREY, spaceAfter=2)
body = ParagraphStyle("body", fontName="Helvetica", fontSize=9.5, leading=13)
bullet = ParagraphStyle("bullet", parent=body, leftIndent=12, bulletIndent=2, spaceAfter=1)

def B(t): return Paragraph(t, bullet, bulletText="-")
def P(t, s=body): return Paragraph(t, s)

story = [
    P("Osamudiamen Edogun", name),
    P("AI Product Manager — Huddersfield, UK (willing to travel) | +44 7939366092 | "
      "edogunosamudiamen@gmail.com | linkedin.com/in/mudyedogun | github.com/bigbrown10", contact),
    HRFlowable(width="100%", thickness=0.7, color=ACCENT),

    P("PROFESSIONAL SUMMARY", h2),
    P("Technical Product Manager with an MSc in Applied AI and Data Analytics (University of Bradford, "
      "completed September 2026) and a BSc in Computer Science. 5+ years shipping AI products end-to-end: "
      "owning product roadmaps, running frontline user discovery, and making build-vs-buy-vs-fine-tune calls "
      "on LLM architectures (RAG, agentic orchestration). Deep technical execution background (Python, SQL, "
      "data pipelines) across fintech and decentralized systems, consistently tying feature delivery to "
      "commercial outcomes."),

    P("PROFESSIONAL EXPERIENCE", h2),

    P("Open Loft — Technical Lead &amp; AI Engineer", role),
    P("March 2026 – Present", meta),
    B("Architecting an agentic platform enabling one-click deployment of \u201cOpen Claw\u201d AI agents; "
      "owning the backend infrastructure end-to-end."),
    B("Designing API integrations and data pipelines connecting ElevenLabs, Lovable and Flock.io for "
      "low-latency agent responses."),
    B("Defining LLM evaluation criteria (output accuracy, API latency, cost per interaction) and optimizing "
      "agentic models against them using user telemetry."),

    P("Kolplay — Technical Product Manager", role),
    P("February 2025 – March 2026", meta),
    B("Directed the end-to-end SDLC for a complex, decentralized AI-integrated platform."),
    B("Engineered agentic orchestration frameworks that automated high-level operational workflows, reducing "
      "manual processes and improving data throughput."),
    B("Ran technical market validation, translating user behaviour data into an actionable engineering roadmap."),

    P("Inscribable — Product Lead", role),
    P("January 2023 – July 2025", meta),
    B("Owned the technical architecture and product lifecycle for a digital-asset launchpad, scaling it past "
      "30,000 active users."),
    B("Synthesized user data and feedback to drive algorithmic improvements and prioritize backend features."),
    B("Designed database schemas and system workflows ensuring high availability and transaction security "
      "during peak market releases."),

    P("Skrape Payment — Data &amp; Product Engineer", role),
    P("January 2021 – December 2022", meta),
    B("Designed architecture and data flows for a highly secure digital payment gateway with a 6-person "
      "engineering team."),
    B("Managed API documentation and database structures in compliance with financial data regulations and "
      "operational security standards."),

    P("Tempa — Growth Data Engineer", role),
    P("March 2020 – January 2021", meta),
    B("Drove a data-led growth strategy that onboarded over 1,000 users to a community funding platform."),
    B("Spearheaded iterative feature development by analyzing quantitative user data to refine product-market fit."),

    P("Arca Payments — Junior Android Developer", role),
    P("August 2019 – March 2020", meta),
    B("Developed internal Android applications improving team workflows and operational data capture."),
    B("Managed the deployment lifecycle for POS machine applications, tracking debugging milestones in Jira."),

    P("EDUCATION", h2),
    P("University of Bradford — MSc, Applied AI and Data Analytics", role),
    P("2025 – 14 September 2026", meta),
    B("Focus: Predictive Modeling, Machine Learning, Data Visualization (SAS), Advanced Statistical Analysis, "
      "Algorithm Design."),
    B("Dissertation: A Framework for Adaptive Memory and Personalized Intervention with Conversational AI."),
    P("Sungkyunkwan University — International Summer School, International Business", role),
    P("June 2026 – July 2026", meta),
    P("University of Benin — BSc, Computer Science", role),
    P("2016 – 2021", meta),

    P("SKILLS", h2),
    B("<b>Product:</b> roadmap ownership, frontline user discovery, A/B testing, feature adoption measurement, "
      "stakeholder management."),
    B("<b>AI/ML:</b> agentic modeling, LLM orchestration, RAG, LangChain, LlamaIndex, vector databases, "
      "predictive modeling."),
    B("<b>Data:</b> Python, TypeScript, SQL, SAS Viya, ETL pipelines, Power BI, data storytelling."),
    B("<b>Tools:</b> n8n, Zapier, Claude Code, GitHub Copilot, Jira, Figma, Lovable, Agile/Scrum."),
]

doc = SimpleDocTemplate("cv.pdf", pagesize=A4,
                        leftMargin=18*mm, rightMargin=18*mm, topMargin=16*mm, bottomMargin=16*mm,
                        title="Osamudiamen Edogun — AI Product Manager", author="Osamudiamen Edogun")
doc.build(story)
print("wrote cv.pdf")
