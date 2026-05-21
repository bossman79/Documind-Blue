'=============================================================================
' DOCUMENT RELATIONSHIP ANALYZER
' Purpose : Scans Sheet "1. Submittal", applies multi-signal scoring across
'           filename tokens, description tokens, vendor, plant, project,
'           discipline, document type, asset/ID, department, and date to
'           build weighted similarity scores between every document pair,
'           then writes a richly formatted "Doc Relationships" report sheet.
' Author  : Generated for Buzzi/Vendor Submittal workbook
' Usage   : Open the macro editor (Alt+F11), paste this entire file into a
'           standard module, then run  BuildDocumentRelationships
'=============================================================================

Option Explicit

'─────────────────────────────────────────────────────────────────────────────
'  TUNEABLE WEIGHTS  (change here to emphasise different signals)
'─────────────────────────────────────────────────────────────────────────────
Private Const W_FILENAME_PREFIX  As Double = 30  ' same leading numeric/alpha prefix
Private Const W_FILENAME_TOKEN   As Double = 20  ' shared meaningful tokens in filename
Private Const W_TITLE_TOKEN      As Double = 18  ' shared meaningful tokens in description
Private Const W_VENDOR           As Double = 15  ' same vendor (normalised)
Private Const W_PLANT            As Double = 10  ' same plant
Private Const W_PROJECT          As Double = 10  ' same project
Private Const W_DISCIPLINE       As Double = 8   ' same discipline
Private Const W_DOCTYPE          As Double = 8   ' same document type
Private Const W_ASSET            As Double = 12  ' overlapping asset/ID tokens
Private Const W_DEPT_CODE        As Double = 6   ' same department code
Private Const W_DEPT_NAME        As Double = 5   ' same department name
Private Const W_CATEGORY         As Double = 4   ' same category letter
Private Const W_DATE_YEAR        As Double = 3   ' same revision-year (±0 yr)
Private Const W_REVISION_SER     As Double = 8   ' revision series match (numeric seq)

'  Minimum score a pair must reach before it is shown in the report
Private Const MIN_SCORE As Double = 35

'  Max relationships shown per document (avoids huge clusters)
Private Const MAX_RELS_PER_DOC As Long = 12

'─────────────────────────────────────────────────────────────────────────────
'  NOISE WORDS – filtered out before token comparison
'─────────────────────────────────────────────────────────────────────────────
Private noiseWords As Object  ' Scripting.Dictionary for O(1) lookup

'─────────────────────────────────────────────────────────────────────────────
'  PRE-COMPUTED PER-DOCUMENT CACHES  (filled once by PrecomputeDocData)
'  Eliminates repeated Tokenise / JaccardSim allocations inside the O(n²) loop
'─────────────────────────────────────────────────────────────────────────────
Private mFnPfx()    As String   ' FilenamePrefix per doc
Private mNormVend() As String   ' NormalVendor per doc
Private mYr()       As String   ' ExtractYear per doc
Private mFnTokD()   As Object   ' filename token Dictionary per doc
Private mTtTokD()   As Object   ' title   token Dictionary per doc
Private mAsTokD()   As Object   ' asset   token Dictionary per doc (keepShortNums)

Private Sub LoadNoiseWords()
    Set noiseWords = CreateObject("Scripting.Dictionary")
    noiseWords.CompareMode = vbTextCompare
    Dim w As Variant
    For Each w In Array("THE", "AND", "FOR", "OF", "IN", "AT", "TO", "BY", _
                        "A", "AN", "WITH", "FROM", "ON", "OR", "IS", "AS", _
                        "BE", "IT", "THIS", "THAT", "ARE", "WAS", "REV", _
                        "REVISION", "SHEET", "PDF", "DWG", "DOC", "FILE", _
                        "NO", "NR", "N", "R", "ID", "REF", "SEE", "PER", _
                        "ALL", "NEW", "OLD", "MISC", "GEN", "GENERAL", _
                        "DETAILS", "DETAIL", "DRAWING", "DRAWINGS", "DWG", _
                        "PAGE", "PAGES", "PLAN", "PLANS", "VIEW", "VIEWS", _
                        "00", "01", "0", "1")
        noiseWords(CStr(w)) = 1
    Next w
End Sub

'─────────────────────────────────────────────────────────────────────────────
'  TOKENISER  – splits a string on non-alphanumeric chars, uppercases,
'               removes pure-numeric tokens shorter than 3 chars and noise
'─────────────────────────────────────────────────────────────────────────────
Private Function Tokenise(ByVal s As String, _
                          Optional ByVal keepShortNums As Boolean = False) _
                          As Collection
    Dim col As New Collection
    Dim i As Long, ch As String, buf As String
    s = UCase(Trim(s))
    ' strip file extension
    If InStr(s, ".") > 0 Then
        Dim ext As String
        ext = Mid(s, InStrRev(s, ".") + 1)
        If Len(ext) <= 4 Then s = Left(s, InStrRev(s, ".") - 1)
    End If
    buf = ""
    For i = 1 To Len(s)
        ch = Mid(s, i, 1)
        If ch Like "[A-Z0-9]" Then
            buf = buf & ch
        Else
            If Len(buf) > 0 Then
                If Not ShouldSkipToken(buf, keepShortNums) Then col.Add buf
                buf = ""
            End If
        End If
    Next i
    If Len(buf) > 0 Then
        If Not ShouldSkipToken(buf, keepShortNums) Then col.Add buf
    End If
    Set Tokenise = col
End Function

Private Function ShouldSkipToken(t As String, keepShortNums As Boolean) As Boolean
    If noiseWords.Exists(t) Then ShouldSkipToken = True: Exit Function
    ' skip 1-2 char pure numbers unless caller wants them
    If Not keepShortNums Then
        If t Like "#" Or t Like "##" Then ShouldSkipToken = True: Exit Function
    End If
    ' skip single letters (category codes etc handled separately)
    If Len(t) = 1 And t Like "[A-Z]" Then ShouldSkipToken = True: Exit Function
    ShouldSkipToken = False
End Function

'─────────────────────────────────────────────────────────────────────────────
'  TOKENISE TO DICTIONARY  – like Tokenise but returns a Scripting.Dictionary
'  (unique tokens as keys).  Used to build the pre-computed caches once so
'  JaccardDict can run without any heap allocation inside the O(n²) loop.
'─────────────────────────────────────────────────────────────────────────────
Private Function TokeniseToDict(ByVal s As String, _
                                Optional ByVal keepShortNums As Boolean = False) _
                                As Object
    Dim d As Object
    Set d = CreateObject("Scripting.Dictionary")
    d.CompareMode = vbTextCompare
    Dim col As Collection
    Set col = Tokenise(s, keepShortNums)
    Dim t As Variant
    For Each t In col : d(CStr(t)) = 1 : Next t
    Set TokeniseToDict = d
End Function

'─────────────────────────────────────────────────────────────────────────────
'  JACCARD ON PRE-BUILT DICTIONARIES  – zero allocations; used in the hot loop
'─────────────────────────────────────────────────────────────────────────────
Private Function JaccardDict(dA As Object, dB As Object) As Double
    If dA.Count = 0 Or dB.Count = 0 Then JaccardDict = 0: Exit Function
    Dim inter As Long
    Dim k As Variant
    For Each k In dA.Keys
        If dB.Exists(k) Then inter = inter + 1
    Next k
    Dim uni As Long : uni = dA.Count + dB.Count - inter
    If uni = 0 Then JaccardDict = 0 Else JaccardDict = inter / CDbl(uni)
End Function

'─────────────────────────────────────────────────────────────────────────────
'  JACCARD SIMILARITY  between two token Collections
'─────────────────────────────────────────────────────────────────────────────
Private Function JaccardSim(cA As Collection, cB As Collection) As Double
    If cA.Count = 0 Or cB.Count = 0 Then JaccardSim = 0: Exit Function
    Dim dA As Object, dB As Object
    Set dA = CreateObject("Scripting.Dictionary")
    Set dB = CreateObject("Scripting.Dictionary")
    dA.CompareMode = vbTextCompare : dB.CompareMode = vbTextCompare
    Dim t As Variant
    For Each t In cA : dA(CStr(t)) = 1 : Next t
    For Each t In cB : dB(CStr(t)) = 1 : Next t
    Dim inter As Long, uni As Long
    Dim k As Variant
    For Each k In dA.Keys
        If dB.Exists(k) Then inter = inter + 1
    Next k
    uni = dA.Count + dB.Count - inter
    If uni = 0 Then JaccardSim = 0 Else JaccardSim = inter / CDbl(uni)
End Function

'─────────────────────────────────────────────────────────────────────────────
'  NORMALISE VENDOR NAME  – collapses common vendor name variants
'─────────────────────────────────────────────────────────────────────────────
Private Function NormalVendor(v As String) As String
    Dim u As String
    u = UCase(Trim(v))
    ' collapse QUALICO variants
    If InStr(u, "QUALICO") > 0 Then NormalVendor = "QUALICO STEEL": Exit Function
    ' collapse TOSHIBA variants
    If InStr(u, "TOSHIBA") > 0 Then NormalVendor = "TOSHIBA": Exit Function
    ' collapse EATON variants
    If InStr(u, "EATON") > 0 Then NormalVendor = "EATON": Exit Function
    ' collapse MACDONALD / MCDONALD ENGINEERING
    If InStr(u, "MACDONALD ENG") > 0 Or InStr(u, "MCDONALD ENG") > 0 Then _
        NormalVendor = "MACDONALD ENGINEERING": Exit Function
    ' collapse ROCKWELL
    If InStr(u, "ROCKWELL") > 0 Then NormalVendor = "ROCKWELL AUTOMATION": Exit Function
    ' collapse ATLAS COPCO
    If InStr(u, "ATLAS COPCO") > 0 Then NormalVendor = "ATLAS COPCO": Exit Function
    ' collapse REDECAM
    If InStr(u, "REDECAM") > 0 Then NormalVendor = "REDECAM": Exit Function
    ' collapse LVTA / LEHIGH VALLEY TECHNICAL
    If InStr(u, "LVTA") > 0 Or InStr(u, "LEHIGH VALLEY TECH") > 0 Or _
       InStr(u, "LVTA ENGINEERING") > 0 Or InStr(u, "LAYVA ENGINEERING") > 0 Then _
        NormalVendor = "LVTA ENGINEERING": Exit Function
    ' collapse FLSMIDTH
    If InStr(u, "FLSMIDTH") > 0 Then NormalVendor = "FLSMIDTH": Exit Function
    ' collapse THYSSENKRUPP
    If InStr(u, "THYSSENKRUPP") > 0 Then NormalVendor = "THYSSENKRUPP INDUSTRIAL": Exit Function
    ' collapse TRANSCO / TRANSOCO
    If InStr(u, "TRANSCO") > 0 Or InStr(u, "TRANSOCO") > 0 Then _
        NormalVendor = "TRANSCO NORTHWEST": Exit Function
    ' collapse ELLIS CONSTRUCTION
    If InStr(u, "ELLIS CONSTRUCTION") > 0 Then NormalVendor = "ELLIS CONSTRUCTION": Exit Function
    ' collapse ABB
    If Left(u, 3) = "ABB" Then NormalVendor = "ABB": Exit Function
    ' collapse REINFORCED EARTH
    If InStr(u, "REINFORCED EARTH") > 0 Then NormalVendor = "REINFORCED EARTH CO": Exit Function
    ' collapse ZACHRY
    If InStr(u, "ZACHRY") > 0 Then NormalVendor = "ZACHRY ENGINEERING": Exit Function
    ' collapse CAB
    If InStr(u, "CAMBRIA") > 0 Or (Left(u, 3) = "CAB" And Len(u) < 10) Then _
        NormalVendor = "CAB": Exit Function
    NormalVendor = u
End Function

'─────────────────────────────────────────────────────────────────────────────
'  EXTRACT LEADING PREFIX  from filename (e.g. "2ME001159", "66904B", "MN-530")
'─────────────────────────────────────────────────────────────────────────────
Private Function FilenamePrefix(fn As String) As String
    ' Grab everything before the first space, underscore, or dash sequence
    Dim parts() As String
    fn = UCase(fn)
    ' strip extension first
    If InStrRev(fn, ".") > 0 Then fn = Left(fn, InStrRev(fn, ".") - 1)
    parts = Split(fn, " ")
    Dim candidate As String
    candidate = Trim(parts(0))
    ' further split on "_" and "-"
    Dim p2() As String
    p2 = Split(candidate, "_")
    candidate = Trim(p2(0))
    ' keep up to 12 chars
    If Len(candidate) > 12 Then candidate = Left(candidate, 12)
    FilenamePrefix = candidate
End Function

'─────────────────────────────────────────────────────────────────────────────
'  REVISION SERIES CHECK  – returns True when two revisions look sequential
'  e.g. Rev0/Rev1, RevA/RevB, 1/2, A/B
'─────────────────────────────────────────────────────────────────────────────
Private Function RevisionsSequential(r1 As String, r2 As String) As Boolean
    r1 = Trim(UCase(r1)) : r2 = Trim(UCase(r2))
    If r1 = "" Or r2 = "" Then RevisionsSequential = False: Exit Function
    ' numeric
    If IsNumeric(r1) And IsNumeric(r2) Then
        RevisionsSequential = (Abs(CDbl(r1) - CDbl(r2)) <= 2)
    ' single alpha
    ElseIf Len(r1) = 1 And r1 Like "[A-Z]" And Len(r2) = 1 And r2 Like "[A-Z]" Then
        RevisionsSequential = (Abs(Asc(r1) - Asc(r2)) <= 2)
    Else
        RevisionsSequential = False
    End If
End Function

'─────────────────────────────────────────────────────────────────────────────
'  YEAR EXTRACTOR  from a date string
'─────────────────────────────────────────────────────────────────────────────
Private Function ExtractYear(d As String) As String
    Dim parts() As String, p As Variant
    If Len(Trim(d)) = 0 Then ExtractYear = "": Exit Function
    ' try slash-delimited
    parts = Split(d, "/")
    If UBound(parts) >= 2 Then
        ' could be MM/DD/YY or MM/DD/YYYY
        Dim yr As String : yr = Trim(parts(UBound(parts)))
        If Len(yr) = 2 Then yr = "20" & yr
        If Len(yr) = 4 And IsNumeric(yr) Then ExtractYear = yr: Exit Function
    End If
    ' try to find 4-digit year anywhere
    Dim i As Long
    For i = 1 To Len(d) - 3
        Dim sub4 As String : sub4 = Mid(d, i, 4)
        If IsNumeric(sub4) Then
            If CLng(sub4) >= 1950 And CLng(sub4) <= 2030 Then
                ExtractYear = sub4: Exit Function
            End If
        End If
    Next i
    ExtractYear = ""
End Function

'─────────────────────────────────────────────────────────────────────────────
'  COMPUTE PAIR SCORE
'─────────────────────────────────────────────────────────────────────────────
Private Function PairScore(i As Long, j As Long, _
    fnArr() As String, titleArr() As String, vendorArr() As String, _
    plantArr() As String, projArr() As String, discArr() As String, _
    dtypeArr() As String, assetArr() As String, deptCodeArr() As String, _
    deptNameArr() As String, catArr() As String, dateArr() As String, _
    revArr() As String) As Double

    Dim score As Double : score = 0

    '── 1. FILENAME PREFIX ──────────────────────────────────────────────────
    Dim pfx1 As String, pfx2 As String
    pfx1 = FilenamePrefix(fnArr(i))
    pfx2 = FilenamePrefix(fnArr(j))
    If Len(pfx1) >= 4 And Len(pfx2) >= 4 Then
        ' exact prefix match
        If pfx1 = pfx2 Then
            score = score + W_FILENAME_PREFIX
        ' prefix starts the same (≥5 chars common leading)
        ElseIf Left(pfx1, 5) = Left(pfx2, 5) Then
            score = score + W_FILENAME_PREFIX * 0.6
        End If
    End If

    '── 2. FILENAME TOKEN JACCARD ───────────────────────────────────────────
    Dim ftok1 As Collection, ftok2 As Collection
    Set ftok1 = Tokenise(fnArr(i))
    Set ftok2 = Tokenise(fnArr(j))
    Dim fj As Double : fj = JaccardSim(ftok1, ftok2)
    score = score + fj * W_FILENAME_TOKEN

    '── 3. TITLE / DESCRIPTION TOKEN JACCARD ────────────────────────────────
    If Len(titleArr(i)) > 3 And Len(titleArr(j)) > 3 Then
        Dim ttok1 As Collection, ttok2 As Collection
        Set ttok1 = Tokenise(titleArr(i))
        Set ttok2 = Tokenise(titleArr(j))
        Dim tj As Double : tj = JaccardSim(ttok1, ttok2)
        score = score + tj * W_TITLE_TOKEN
        ' bonus for very high title similarity
        If tj > 0.7 Then score = score + 5
    End If

    '── 4. VENDOR (normalised exact match) ──────────────────────────────────
    Dim v1 As String, v2 As String
    v1 = NormalVendor(vendorArr(i)) : v2 = NormalVendor(vendorArr(j))
    If v1 <> "" And v1 = v2 Then score = score + W_VENDOR

    '── 5. PLANT ────────────────────────────────────────────────────────────
    If plantArr(i) <> "" And UCase(plantArr(i)) = UCase(plantArr(j)) Then _
        score = score + W_PLANT

    '── 6. PROJECT ──────────────────────────────────────────────────────────
    If projArr(i) <> "" And UCase(Trim(projArr(i))) = UCase(Trim(projArr(j))) Then _
        score = score + W_PROJECT

    '── 7. DISCIPLINE ────────────────────────────────────────────────────────
    If discArr(i) <> "" And UCase(discArr(i)) = UCase(discArr(j)) Then _
        score = score + W_DISCIPLINE

    '── 8. DOCUMENT TYPE ────────────────────────────────────────────────────
    If dtypeArr(i) <> "" And UCase(dtypeArr(i)) = UCase(dtypeArr(j)) Then _
        score = score + W_DOCTYPE

    '── 9. ASSET / ID NUMBER – token overlap ────────────────────────────────
    If Len(assetArr(i)) > 2 And Len(assetArr(j)) > 2 Then
        Dim atok1 As Collection, atok2 As Collection
        Set atok1 = Tokenise(assetArr(i), True)
        Set atok2 = Tokenise(assetArr(j), True)
        Dim aj As Double : aj = JaccardSim(atok1, atok2)
        score = score + aj * W_ASSET
        ' bonus for exact asset match
        If UCase(Trim(assetArr(i))) = UCase(Trim(assetArr(j))) Then score = score + 6
    End If

    '── 10. DEPARTMENT CODE ─────────────────────────────────────────────────
    If deptCodeArr(i) <> "" And deptCodeArr(i) = deptCodeArr(j) Then _
        score = score + W_DEPT_CODE

    '── 11. DEPARTMENT NAME ─────────────────────────────────────────────────
    If deptNameArr(i) <> "" And UCase(deptNameArr(i)) = UCase(deptNameArr(j)) Then _
        score = score + W_DEPT_NAME

    '── 12. CATEGORY ────────────────────────────────────────────────────────
    If catArr(i) <> "" And UCase(catArr(i)) = UCase(catArr(j)) Then _
        score = score + W_CATEGORY

    '── 13. DATE YEAR ────────────────────────────────────────────────────────
    Dim yr1 As String, yr2 As String
    yr1 = ExtractYear(dateArr(i)) : yr2 = ExtractYear(dateArr(j))
    If yr1 <> "" And yr2 <> "" And yr1 = yr2 Then score = score + W_DATE_YEAR

    '── 14. REVISION SERIES ─────────────────────────────────────────────────
    If RevisionsSequential(revArr(i), revArr(j)) Then score = score + W_REVISION_SER

    PairScore = score
End Function

'─────────────────────────────────────────────────────────────────────────────
'  GET DOC PARENT SCORE – ranks documents within a cluster to find the leader
'─────────────────────────────────────────────────────────────────────────────
Private Function GetDocParentScore(i As Long, fnArr() As String, titleArr() As String, dtypeArr() As String) As Double
    Dim score As Double: score = 0
    
    Dim ext As String, pos As Long
    pos = InStrRev(fnArr(i), ".")
    If pos > 0 Then ext = UCase(Mid(fnArr(i), pos + 1)) Else ext = ""
    
    If ext = "PDF" Then score = score + 50
    If ext = "DWG" Then score = score + 30
    If ext = "DOC" Or ext = "DOCX" Or ext = "XLS" Or ext = "XLSX" Then score = score + 10
    
    Dim t As String: t = UCase(titleArr(i))
    Dim parentWords As Variant, childWords As Variant
    parentWords = Array("ASSEMBLY", "ASSY", "GENERAL", "LAYOUT", "MAIN", "OVERVIEW", "SYSTEM", "PLAN")
    childWords = Array("DETAIL", "PART", "COMPONENT", "SECTION", "LIST", "BOM", "BILL OF MATERIAL", "SCHEDULE")
    
    Dim w As Variant
    For Each w In parentWords
        If InStr(t, w) > 0 Then score = score + 25
    Next w
    For Each w In childWords
        If InStr(t, w) > 0 Then score = score - 25
    Next w
    
    Dim dt As String: dt = UCase(dtypeArr(i))
    If InStr(dt, "DRAWING") > 0 Or InStr(dt, "PLAN") > 0 Then score = score + 15
    If InStr(dt, "BOM") > 0 Or InStr(dt, "LIST") > 0 Then score = score - 15
    
    ' Shorter filename gets a slight advantage to break ties (base names > suffixed names)
    score = score - (Len(fnArr(i)) * 0.1)
    
    GetDocParentScore = score
End Function

'─────────────────────────────────────────────────────────────────────────────
'  RELATIONSHIP LABEL  – human-readable description of WHY two docs are related
'─────────────────────────────────────────────────────────────────────────────
Private Function RelationshipLabel(i As Long, j As Long, _
    fnArr() As String, titleArr() As String, vendorArr() As String, _
    plantArr() As String, projArr() As String, discArr() As String, _
    dtypeArr() As String, assetArr() As String, deptCodeArr() As String, _
    deptNameArr() As String, catArr() As String, dateArr() As String, _
    revArr() As String, score As Double) As String

    Dim reasons() As String
    ReDim reasons(0 To 20) : Dim cnt As Long : cnt = 0

    Dim pfx1 As String, pfx2 As String
    pfx1 = FilenamePrefix(fnArr(i)) : pfx2 = FilenamePrefix(fnArr(j))
    If Len(pfx1) >= 4 And Len(pfx2) >= 4 Then
        If pfx1 = pfx2 Then reasons(cnt) = "Same file prefix (" & pfx1 & ")": cnt = cnt + 1
    End If

    Dim ftok1 As Collection, ftok2 As Collection
    Set ftok1 = Tokenise(fnArr(i)) : Set ftok2 = Tokenise(fnArr(j))
    If JaccardSim(ftok1, ftok2) >= 0.35 Then
        reasons(cnt) = "Similar filename tokens": cnt = cnt + 1
    End If

    If Len(titleArr(i)) > 3 And Len(titleArr(j)) > 3 Then
        Dim ttok1 As Collection, ttok2 As Collection
        Set ttok1 = Tokenise(titleArr(i)) : Set ttok2 = Tokenise(titleArr(j))
        Dim tj As Double : tj = JaccardSim(ttok1, ttok2)
        If tj >= 0.5 Then
            reasons(cnt) = "Very similar description"
            If tj >= 0.8 Then reasons(cnt) = "Nearly identical description"
            cnt = cnt + 1
        ElseIf tj >= 0.25 Then
            reasons(cnt) = "Overlapping description keywords": cnt = cnt + 1
        End If
    End If

    Dim v1 As String, v2 As String
    v1 = NormalVendor(vendorArr(i)) : v2 = NormalVendor(vendorArr(j))
    If v1 <> "" And v1 = v2 Then reasons(cnt) = "Same vendor: " & v1: cnt = cnt + 1

    If plantArr(i) <> "" And UCase(plantArr(i)) = UCase(plantArr(j)) Then _
        reasons(cnt) = "Same plant: " & plantArr(i): cnt = cnt + 1

    If projArr(i) <> "" And UCase(Trim(projArr(i))) = UCase(Trim(projArr(j))) Then _
        reasons(cnt) = "Same project: " & projArr(i): cnt = cnt + 1

    If discArr(i) <> "" And UCase(discArr(i)) = UCase(discArr(j)) Then _
        reasons(cnt) = "Same discipline: " & discArr(i): cnt = cnt + 1

    If dtypeArr(i) <> "" And UCase(dtypeArr(i)) = UCase(dtypeArr(j)) Then _
        reasons(cnt) = "Same doc type: " & dtypeArr(i): cnt = cnt + 1

    If Len(assetArr(i)) > 2 And Len(assetArr(j)) > 2 Then
        If UCase(Trim(assetArr(i))) = UCase(Trim(assetArr(j))) Then
            reasons(cnt) = "Identical asset/ID: " & assetArr(i): cnt = cnt + 1
        ElseIf JaccardSim(Tokenise(assetArr(i), True), Tokenise(assetArr(j), True)) >= 0.4 Then
            reasons(cnt) = "Overlapping asset/ID numbers": cnt = cnt + 1
        End If
    End If

    If deptCodeArr(i) <> "" And deptCodeArr(i) = deptCodeArr(j) Then _
        reasons(cnt) = "Same dept code: " & deptCodeArr(i): cnt = cnt + 1

    If RevisionsSequential(revArr(i), revArr(j)) Then _
        reasons(cnt) = "Sequential revisions (" & revArr(i) & "→" & revArr(j) & ")": cnt = cnt + 1

    Dim yr1 As String, yr2 As String
    yr1 = ExtractYear(dateArr(i)) : yr2 = ExtractYear(dateArr(j))
    If yr1 <> "" And yr2 <> "" And yr1 = yr2 Then _
        reasons(cnt) = "Same revision year: " & yr1: cnt = cnt + 1

    If cnt = 0 Then
        RelationshipLabel = "Multiple weak shared signals (score: " & Format(score, "0") & ")"
        Exit Function
    End If

    Dim out As String : out = ""
    Dim k As Long
    For k = 0 To cnt - 1
        If k > 0 Then out = out & " | "
        out = out & reasons(k)
    Next k
    RelationshipLabel = out
End Function

'─────────────────────────────────────────────────────────────────────────────
'  STRENGTH BAND  label and colour for a score
'─────────────────────────────────────────────────────────────────────────────
Private Sub ScoreBand(score As Double, ByRef bandLabel As String, _
                      ByRef bandColor As Long)
    If score >= 100 Then
        bandLabel = "VERY STRONG"  : bandColor = RGB(0, 176, 80)
    ElseIf score >= 75 Then
        bandLabel = "STRONG"       : bandColor = RGB(70, 130, 180)
    ElseIf score >= 55 Then
        bandLabel = "MODERATE"     : bandColor = RGB(255, 165, 0)
    Else
        bandLabel = "WEAK"         : bandColor = RGB(200, 200, 200)
    End If
End Sub

'─────────────────────────────────────────────────────────────────────────────
'  CLUSTER DETECTION  – simple union-find to group tightly related docs
'─────────────────────────────────────────────────────────────────────────────
Private Function FindRoot(parent() As Long, x As Long) As Long
    If parent(x) <> x Then parent(x) = FindRoot(parent, parent(x))
    FindRoot = parent(x)
End Function

Private Sub Union(parent() As Long, rank() As Long, x As Long, y As Long)
    Dim rx As Long, ry As Long
    rx = FindRoot(parent, x) : ry = FindRoot(parent, y)
    If rx = ry Then Exit Sub
    If rank(rx) < rank(ry) Then
        parent(rx) = ry
    ElseIf rank(rx) > rank(ry) Then
        parent(ry) = rx
    Else
        parent(ry) = rx : rank(rx) = rank(rx) + 1
    End If
End Sub

'=============================================================================
'  MAIN ENTRY POINT
'=============================================================================
Public Sub BuildDocumentRelationships()

    Application.ScreenUpdating = False
    Application.Calculation = xlCalculationManual
    Application.StatusBar = "Initialising…"

    LoadNoiseWords

    '── Locate source sheet ────────────────────────────────────────────────
    Dim srcSheet As Worksheet
    On Error Resume Next
    Set srcSheet = ThisWorkbook.Sheets("1. Submittal")
    On Error GoTo 0
    If srcSheet Is Nothing Then
        MsgBox "Sheet '1. Submittal' not found. Please check the sheet name.", vbCritical
        GoTo CleanUp
    End If

    '── Add hierarchy columns to source sheet ──────────────────────────────
    srcSheet.Cells(1, 17).Value = "Is Parent"
    srcSheet.Cells(1, 18).Value = "Is Child"
    srcSheet.Cells(1, 19).Value = "Related Group"

    '── Find data range ────────────────────────────────────────────────────
    Dim lastRow As Long
    lastRow = srcSheet.Cells(srcSheet.Rows.Count, 1).End(xlUp).Row
    If lastRow < 2 Then
        MsgBox "No data rows found in sheet '1. Submittal'.", vbInformation
        GoTo CleanUp
    End If

    Dim nDocs As Long : nDocs = lastRow - 1   ' row 1 = header

    '── Read all data into arrays (fast) ───────────────────────────────────
    Application.StatusBar = "Reading data (" & nDocs & " documents)…"
    Dim dataRange As Range
    Set dataRange = srcSheet.Range("A2:P" & lastRow)  ' A=Filename … P=Clean Title
    Dim data() As Variant
    data = dataRange.Value

    ' column indices (1-based inside data array, matching the spreadsheet cols A-P)
    Const C_FN   As Long = 1   ' Filename
    Const C_STAT As Long = 2   ' Issue Status
    Const C_REV  As Long = 3   ' Revision
    Const C_DATE As Long = 4   ' Revision Date
    Const C_DESC As Long = 5   ' Description / Title
    Const C_DISC As Long = 6   ' Discipline
    Const C_CAT  As Long = 7   ' Category
    Const C_ASST As Long = 8   ' Asset / ID Number
    Const C_PROJ As Long = 9   ' Project
    Const C_PLNT As Long = 10  ' Plant
    Const C_DEPT As Long = 11  ' Department Code
    Const C_DTYP As Long = 12  ' Document Type
    Const C_VNDR As Long = 13  ' Vendor Name
    Const C_LOC  As Long = 14  ' Location
    Const C_DNAM As Long = 15  ' Department Name
    Const C_TTLP As Long = 16  ' Clean Title (Preview)

    ' Arrays for each field
    Dim fnArr()     As String : ReDim fnArr(1 To nDocs)
    Dim titleArr()  As String : ReDim titleArr(1 To nDocs)
    Dim vendorArr() As String : ReDim vendorArr(1 To nDocs)
    Dim plantArr()  As String : ReDim plantArr(1 To nDocs)
    Dim projArr()   As String : ReDim projArr(1 To nDocs)
    Dim discArr()   As String : ReDim discArr(1 To nDocs)
    Dim dtypeArr()  As String : ReDim dtypeArr(1 To nDocs)
    Dim assetArr()  As String : ReDim assetArr(1 To nDocs)
    Dim deptCodeArr() As String : ReDim deptCodeArr(1 To nDocs)
    Dim deptNameArr() As String : ReDim deptNameArr(1 To nDocs)
    Dim catArr()    As String : ReDim catArr(1 To nDocs)
    Dim dateArr()   As String : ReDim dateArr(1 To nDocs)
    Dim revArr()    As String : ReDim revArr(1 To nDocs)
    Dim statusArr() As String : ReDim statusArr(1 To nDocs)

    Dim r As Long
    For r = 1 To nDocs
        fnArr(r)       = CStr(IIf(IsError(data(r, C_FN)),   "", data(r, C_FN)))
        titleArr(r)    = CStr(IIf(IsError(data(r, C_DESC)), "", data(r, C_DESC)))
        If Len(Trim(titleArr(r))) = 0 Then _
            titleArr(r) = CStr(IIf(IsError(data(r, C_TTLP)), "", data(r, C_TTLP)))
        vendorArr(r)   = CStr(IIf(IsError(data(r, C_VNDR)), "", data(r, C_VNDR)))
        plantArr(r)    = CStr(IIf(IsError(data(r, C_PLNT)), "", data(r, C_PLNT)))
        projArr(r)     = CStr(IIf(IsError(data(r, C_PROJ)), "", data(r, C_PROJ)))
        discArr(r)     = CStr(IIf(IsError(data(r, C_DISC)), "", data(r, C_DISC)))
        dtypeArr(r)    = CStr(IIf(IsError(data(r, C_DTYP)), "", data(r, C_DTYP)))
        assetArr(r)    = CStr(IIf(IsError(data(r, C_ASST)), "", data(r, C_ASST)))
        deptCodeArr(r) = CStr(IIf(IsError(data(r, C_DEPT)), "", data(r, C_DEPT)))
        deptNameArr(r) = CStr(IIf(IsError(data(r, C_DNAM)), "", data(r, C_DNAM)))
        catArr(r)      = CStr(IIf(IsError(data(r, C_CAT)),  "", data(r, C_CAT)))
        dateArr(r)     = CStr(IIf(IsError(data(r, C_DATE)), "", data(r, C_DATE)))
        revArr(r)      = CStr(IIf(IsError(data(r, C_REV)),  "", data(r, C_REV)))
        statusArr(r)   = CStr(IIf(IsError(data(r, C_STAT)), "", data(r, C_STAT)))
    Next r

    '── Compute all pair scores ────────────────────────────────────────────
    Application.StatusBar = "Scoring document pairs… (this may take a moment)"

    ' We use a 2-D array to hold scores for significant pairs
    ' Since nDocs can be ~1000, n^2=1M pairs; we only store those above threshold
    ' Store as: pairList(k,0)=i, pairList(k,1)=j, pairList(k,2)=score
    Dim pairCount As Long : pairCount = 0
    Dim pairCap   As Long : pairCap = 10000
    ReDim pairI(1 To pairCap)    As Long
    ReDim pairJ(1 To pairCap)    As Long
    ReDim pairS(1 To pairCap)    As Double
    ReDim pairL(1 To pairCap)    As String

    Dim i As Long, j As Long, sc As Double
    Dim progressStep As Long : progressStep = nDocs \ 20
    If progressStep < 1 Then progressStep = 1

    For i = 1 To nDocs
        If fnArr(i) = "" Then GoTo NextI
        If i Mod progressStep = 0 Then
            Application.StatusBar = "Scoring pairs: doc " & i & " of " & nDocs & _
                " (" & Format(i / nDocs * 100, "0") & "%)…"
        End If
        For j = i + 1 To nDocs
            If fnArr(j) = "" Then GoTo NextJ
            sc = PairScore(i, j, fnArr, titleArr, vendorArr, plantArr, projArr, _
                           discArr, dtypeArr, assetArr, deptCodeArr, deptNameArr, _
                           catArr, dateArr, revArr)
            If sc >= MIN_SCORE Then
                pairCount = pairCount + 1
                If pairCount > pairCap Then
                    pairCap = pairCap + 5000
                    ReDim Preserve pairI(1 To pairCap)
                    ReDim Preserve pairJ(1 To pairCap)
                    ReDim Preserve pairS(1 To pairCap)
                    ReDim Preserve pairL(1 To pairCap)
                End If
                pairI(pairCount) = i
                pairJ(pairCount) = j
                pairS(pairCount) = sc
                pairL(pairCount) = RelationshipLabel(i, j, fnArr, titleArr, _
                    vendorArr, plantArr, projArr, discArr, dtypeArr, assetArr, _
                    deptCodeArr, deptNameArr, catArr, dateArr, revArr, sc)
            End If
NextJ:
        Next j
NextI:
    Next i

    Application.StatusBar = "Found " & pairCount & " related pairs. Building clusters…"

    '── Union-Find clustering (strong pairs only: score ≥ 60) ──────────────
    Dim parent() As Long : ReDim parent(1 To nDocs)
    Dim rnk()    As Long : ReDim rnk(1 To nDocs)
    For r = 1 To nDocs : parent(r) = r : rnk(r) = 0 : Next r

    Dim k As Long
    For k = 1 To pairCount
        If pairS(k) >= 60 Then
            Call Union(parent, rnk, pairI(k), pairJ(k))
        End If
    Next k

    ' Map root → cluster index
    Dim clusterMap As Object
    Set clusterMap = CreateObject("Scripting.Dictionary")
    Dim clusterIdx As Long : clusterIdx = 0
    For r = 1 To nDocs
        If fnArr(r) <> "" Then
            Dim root As Long : root = FindRoot(parent, r)
            If Not clusterMap.Exists(root) Then
                clusterIdx = clusterIdx + 1
                clusterMap(root) = clusterIdx
            End If
        End If
    Next r

    Dim nClusters As Long : nClusters = clusterIdx

    '── Build per-document relationship lists ──────────────────────────────
    Application.StatusBar = "Building relationship lists…"
    ' docRels(i) = sorted list of (score, j, label) for document i
    ' We store compact string arrays per doc sorted by score desc
    ' Format: score|j|label
    Dim docRelList() As Object  ' Collection per doc
    ReDim docRelList(1 To nDocs)
    For r = 1 To nDocs : Set docRelList(r) = New Collection : Next r

    For k = 1 To pairCount
        i = pairI(k) : j = pairJ(k) : sc = pairS(k)
        Dim entry As String
        entry = Format(sc, "000.0") & "|" & j & "|" & pairL(k)
        docRelList(i).Add entry
        entry = Format(sc, "000.0") & "|" & i & "|" & pairL(k)
        docRelList(j).Add entry
    Next k

    ' Sort each doc's list descending by score (simple insertion sort on Collection)
    For r = 1 To nDocs
        If docRelList(r).Count > 1 Then
            Dim arr() As String
            ReDim arr(1 To docRelList(r).Count)
            Dim m As Long : m = 0
            Dim itm As Variant
            For Each itm In docRelList(r) : m = m + 1 : arr(m) = CStr(itm) : Next itm
            ' Sort descending (score is first 6 chars, so string sort works)
            Dim p As Long, q As Long, tmp As String
            For p = 1 To m - 1
                For q = p + 1 To m
                    If arr(q) > arr(p) Then tmp = arr(p) : arr(p) = arr(q) : arr(q) = tmp
                Next q
            Next p
            ' Rebuild collection
            Set docRelList(r) = New Collection
            For p = 1 To m : docRelList(r).Add arr(p) : Next p
        End If
    Next r

    '── Determine Hierarchy (Parent / Child) for each cluster ──────────────
    Application.StatusBar = "Determining cluster hierarchy…"
    Dim clusterDocs() As Object  ' Collection(doc indices) per cluster
    ReDim clusterDocs(1 To nClusters)
    For r = 1 To nClusters : Set clusterDocs(r) = New Collection : Next r
    
    For r = 1 To nDocs
        If fnArr(r) <> "" Then
            Dim cIdx As Long
            cIdx = clusterMap(FindRoot(parent, r))
            clusterDocs(cIdx).Add r
        End If
    Next r

    ' Sort clusters by size descending using parallel arrays
    Dim csizes() As Long : ReDim csizes(1 To nClusters)
    Dim corder() As Long : ReDim corder(1 To nClusters)
    For r = 1 To nClusters : csizes(r) = clusterDocs(r).Count : corder(r) = r : Next r
    Dim ci As Long, cj As Long, ctmp As Long
    For ci = 1 To nClusters - 1
        For cj = ci + 1 To nClusters
            If csizes(corder(cj)) > csizes(corder(ci)) Then
                ctmp = corder(ci) : corder(ci) = corder(cj) : corder(cj) = ctmp
            End If
        Next cj
    Next ci

    ' Process each cluster to find the parent — store result for use in report
    Dim clusterParent() As Long : ReDim clusterParent(1 To nClusters)  ' stores bestParentIdx per cluster
    Dim shownClusters As Long: shownClusters = 0
    For ci = 1 To nClusters
        Dim realC As Long : realC = corder(ci)
        If clusterDocs(realC).Count < 2 Then GoTo SkipParentCheck
        shownClusters = shownClusters + 1
        
        Dim bestParentIdx As Long
        Dim bestParentScore As Double: bestParentScore = -99999
        
        Dim docIdx As Variant
        For Each docIdx In clusterDocs(realC)
            Dim pScore As Double
            pScore = GetDocParentScore(CLng(docIdx), fnArr, titleArr, dtypeArr)
            If pScore > bestParentScore Then
                bestParentScore = pScore
                bestParentIdx = CLng(docIdx)
            End If
        Next docIdx
        
        clusterParent(realC) = bestParentIdx  ' cache for report
        
        ' Write to source sheet
        For Each docIdx In clusterDocs(realC)
            Dim isP As Boolean: isP = False
            If CLng(docIdx) = bestParentIdx Then isP = True
            
            srcSheet.Cells(CLng(docIdx) + 1, 17).Value = isP
            srcSheet.Cells(CLng(docIdx) + 1, 18).Value = Not isP
            srcSheet.Cells(CLng(docIdx) + 1, 19).Value = "Group " & shownClusters
        Next docIdx
        
SkipParentCheck:
    Next ci

    '── Create / clear report sheet ────────────────────────────────────────
    Application.StatusBar = "Writing report sheet…"
    Dim repSheet As Worksheet
    On Error Resume Next
    Set repSheet = ThisWorkbook.Sheets("Doc Relationships")
    On Error GoTo 0
    If repSheet Is Nothing Then
        Set repSheet = ThisWorkbook.Sheets.Add(After:=srcSheet)
        repSheet.Name = "Doc Relationships"
    Else
        repSheet.Cells.Clear
        repSheet.Cells.ClearFormats
    End If

    '── Report layout ──────────────────────────────────────────────────────
    With repSheet

        '-- Title block -------------------------------------------------
        .Tab.Color = RGB(0, 70, 127)
        .Cells(1, 1).Value = "DOCUMENT RELATIONSHIP REPORT"
        With .Range("A1:H1")
            .Merge
            .Font.Bold = True
            .Font.Size = 16
            .Font.Color = RGB(255, 255, 255)
            .Interior.Color = RGB(0, 70, 127)
            .HorizontalAlignment = xlCenter
            .RowHeight = 30
        End With

        .Cells(2, 1).Value = "Source sheet: 1. Submittal   |   Documents analysed: " & nDocs & _
                             "   |   Related pairs found: " & pairCount & _
                             "   |   Clusters (strong links): " & nClusters & _
                             "   |   Generated: " & Now()
        With .Range("A2:H2")
            .Merge
            .Font.Italic = True
            .Font.Size = 9
            .Interior.Color = RGB(220, 230, 241)
            .HorizontalAlignment = xlCenter
        End With

        '-- Legend -------------------------------------------------------
        Dim lRow As Long : lRow = 4
        .Cells(lRow, 1).Value = "STRENGTH LEGEND:"
        .Cells(lRow, 1).Font.Bold = True
        Dim legItems(0 To 3, 0 To 1) As String
        legItems(0, 0) = "VERY STRONG (≥100)" : legItems(0, 1) = "100"
        legItems(1, 0) = "STRONG (75-99)"      : legItems(1, 1) = "75"
        legItems(2, 0) = "MODERATE (55-74)"    : legItems(2, 1) = "55"
        legItems(3, 0) = "WEAK (35-54)"        : legItems(3, 1) = "35"
        Dim lc As Long
        For lc = 0 To 3
            Dim lbl2 As String, clr2 As Long
            Call ScoreBand(CDbl(legItems(lc, 1)), lbl2, clr2)
            With .Cells(lRow, 2 + lc)
                .Value = legItems(lc, 0)
                .Interior.Color = clr2
                .Font.Color = IIf(clr2 = RGB(200, 200, 200), RGB(0, 0, 0), RGB(255, 255, 255))
                .Font.Bold = True
                .Font.Size = 8
                .HorizontalAlignment = xlCenter
                .Borders.LineStyle = xlContinuous
            End With
        Next lc

        '-- Section: GROUP HIERARCHY DETAIL ------------------------------
        Dim cRow As Long : cRow = lRow + 2
        .Cells(cRow, 1).Value = "GROUP HIERARCHY DETAIL (Parent & Child Documents)"
        With .Range(.Cells(cRow, 1), .Cells(cRow, 8))
            .Merge
            .Font.Bold = True : .Font.Size = 12 : .Font.Color = RGB(255, 255, 255)
            .Interior.Color = RGB(31, 73, 125)
            .RowHeight = 22
        End With
        cRow = cRow + 1

        ' Loop through the already sorted clusters
        'docIdx variable already declared earlier
        For ci = 1 To nClusters
            realC = corder(ci) ' set current cluster index
            If clusterDocs(realC).Count < 2 Then GoTo NextClusterDetail

            Dim mc As Long : mc = clusterDocs(realC).Count  ' mc kept, but realC already declared
            bestParentIdx = clusterParent(realC)  ' use pre-computed value

            ' Group Header
            With .Range(.Cells(cRow, 1), .Cells(cRow, 8))
                .Merge
                .Value = "▶  GROUP " & ci & " (" & mc & " documents)"
                .Font.Bold = True : .Font.Size = 10
                .Interior.Color = RGB(68, 114, 196)
                .Font.Color = RGB(255, 255, 255)
                .RowHeight = 18
                .HorizontalAlignment = xlLeft
                .IndentLevel = 1
            End With
            cRow = cRow + 1

            ' Column Headers
            With .Range(.Cells(cRow, 1), .Cells(cRow, 8))
                .Interior.Color = RGB(189, 215, 238)
                .Font.Bold = True : .Font.Size = 9
            End With
            .Cells(cRow, 1).Value = "  Hierarchy Role"
            .Cells(cRow, 2).Value = "Filename"
            .Cells(cRow, 3).Value = "Description"
            .Cells(cRow, 4).Value = "Vendor"
            .Cells(cRow, 5).Value = "Plant"
            .Cells(cRow, 6).Value = "Project"
            .Cells(cRow, 7).Value = "Doc Type"
            .Cells(cRow, 8).Value = "Discipline"
            cRow = cRow + 1

            ' Print Parent First
            Dim altBg As Long: altBg = RGB(255, 255, 255)
            With .Range(.Cells(cRow, 1), .Cells(cRow, 8))
                .Interior.Color = altBg
                .Font.Bold = True
            End With
            .Cells(cRow, 1).Value = "  [PARENT]"
            .Cells(cRow, 2).Value = fnArr(bestParentIdx)
            .Cells(cRow, 3).Value = titleArr(bestParentIdx)
            .Cells(cRow, 4).Value = NormalVendor(vendorArr(bestParentIdx))
            .Cells(cRow, 5).Value = plantArr(bestParentIdx)
            .Cells(cRow, 6).Value = projArr(bestParentIdx)
            .Cells(cRow, 7).Value = dtypeArr(bestParentIdx)
            .Cells(cRow, 8).Value = discArr(bestParentIdx)
            cRow = cRow + 1
            
            ' Print Children
            altBg = RGB(242, 242, 242)
            For Each docIdx In clusterDocs(realC)
                If CLng(docIdx) <> bestParentIdx Then
                    With .Range(.Cells(cRow, 1), .Cells(cRow, 8))
                        .Interior.Color = altBg
                    End With
                    .Cells(cRow, 1).Value = "      ↳ Child"
                    .Cells(cRow, 2).Value = fnArr(CLng(docIdx))
                    .Cells(cRow, 3).Value = titleArr(CLng(docIdx))
                    .Cells(cRow, 4).Value = NormalVendor(vendorArr(CLng(docIdx)))
                    .Cells(cRow, 5).Value = plantArr(CLng(docIdx))
                    .Cells(cRow, 6).Value = projArr(CLng(docIdx))
                    .Cells(cRow, 7).Value = dtypeArr(CLng(docIdx))
                    .Cells(cRow, 8).Value = discArr(CLng(docIdx))
                    cRow = cRow + 1
                End If
            Next docIdx

            ' Spacer
            cRow = cRow + 1

NextClusterDetail:
        Next ci

        '-- Apply column widths and borders throughout --------------------
        Application.StatusBar = "Formatting report…"
        .Columns("A").ColumnWidth = 40
        .Columns("B").ColumnWidth = 8
        .Columns("C").ColumnWidth = 14
        .Columns("D").ColumnWidth = 14
        .Columns("E").ColumnWidth = 60
        .Columns("F").ColumnWidth = 40
        .Columns("G").ColumnWidth = 22
        .Columns("H").ColumnWidth = 28

        ' Wrap text on key long columns
        .Columns("A").WrapText = False
        .Columns("E").WrapText = True
        .Columns("F").WrapText = False

        ' Freeze panes after row 3
        .Activate
        ActiveWindow.FreezePanes = False
        .Range("A4").Select
        ActiveWindow.FreezePanes = True

        ' Zoom
        ActiveWindow.Zoom = 85

        ' Auto-fit row heights (only up to 300 rows to keep it fast)
        If cRow < 300 Then .Rows("1:" & cRow).AutoFit

    End With  ' repSheet

    repSheet.Activate
    repSheet.Range("A1").Select

    Application.StatusBar = False
    Application.ScreenUpdating = True
    Application.Calculation = xlCalculationAutomatic

    MsgBox "Document Relationship Report complete!" & vbCrLf & vbCrLf & _
           "Documents analysed : " & nDocs & vbCrLf & _
           "Related pairs found: " & pairCount & vbCrLf & _
           "Strong clusters    : " & shownClusters & vbCrLf & vbCrLf & _
           "See sheet: 'Doc Relationships'", vbInformation, "Analysis Complete"
    Exit Sub

CleanUp:
    Application.ScreenUpdating = True
    Application.Calculation = xlCalculationAutomatic
    Application.StatusBar = False
End Sub

'─────────────────────────────────────────────────────────────────────────────
'  HELPER: return the key with the highest count in a Scripting.Dictionary
'─────────────────────────────────────────────────────────────────────────────
Private Function MaxKey(d As Object) As String
    Dim bestKey As String : bestKey = ""
    Dim bestVal As Long   : bestVal = 0
    Dim k As Variant
    For Each k In d.Keys
        If d(k) > bestVal Then bestVal = d(k) : bestKey = CStr(k)
    Next k
    MaxKey = bestKey
End Function
