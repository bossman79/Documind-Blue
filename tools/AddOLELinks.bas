Attribute VB_Name = "AddOLELinks"
' Run from Excel: Developer > Visual Basic > File > Import File > AddOLELinks.bas
' Then Run macro: AddLinkedOLEFromDocuments
'
' Prerequisites:
'   - Sheet "Documents" with filenames in column A (row 2+)
'   - Documents!Z1 = full folder path with trailing backslash (e.g. \\server\share\Drawings\)
'   - Sheet "OLE_Links" will be created if missing; existing OLE objects on that sheet are removed first.

Option Explicit

Public Sub AddLinkedOLEFromDocuments()
    Dim doc As Worksheet
    Dim oleWs As Worksheet
    Dim basePath As String
    Dim r As Long
    Dim fn As String
    Dim fullpath As String
    Dim lastRow As Long
    
    On Error GoTo ErrHandler
    
    Set doc = Worksheets("Documents")
    Set oleWs = GetOrCreateOLESheet(doc)
    ClearOLEObjects oleWs
    
    basePath = Trim(CStr(doc.Range("Z1").Value))
    If basePath = "" Then
        MsgBox "Set Documents!Z1 to the folder that contains these files (with trailing \).", vbExclamation
        Exit Sub
    End If
    If Right(basePath, 1) <> "\" Then basePath = basePath & "\"
    
    lastRow = doc.Cells(doc.Rows.Count, 1).End(xlUp).Row
    r = 2
    Do While r <= lastRow
        fn = Trim(CStr(doc.Cells(r, 1).Value))
        If fn <> "" Then
            fullpath = basePath & fn
            oleWs.Cells(r, 1).Value = fn
            If Dir(fullpath) <> "" Then
                oleWs.OLEObjects.Add _
                    Filename:=fullpath, _
                    Link:=True, _
                    DisplayAsIcon:=True, _
                    Left:=oleWs.Cells(r, 2).Left, _
                    Top:=oleWs.Cells(r, 2).Top, _
                    Width:=72, _
                    Height:=72
                oleWs.Cells(r, 3).Value = "OK (linked OLE)"
            Else
                oleWs.Cells(r, 3).Value = "Skipped (not found): " & fullpath
            End If
        End If
        r = r + 1
    Loop
    
    MsgBox "Finished. See sheet OLE_Links, column C for status.", vbInformation
    Exit Sub
    
ErrHandler:
    MsgBox "Error " & Err.Number & ": " & Err.Description, vbCritical
End Sub

Private Function GetOrCreateOLESheet(ByVal afterDoc As Worksheet) As Worksheet
    Dim ws As Worksheet
    For Each ws In Worksheets
        If ws.Name = "OLE_Links" Then
            Set GetOrCreateOLESheet = ws
            Exit Function
        End If
    Next ws
    Set ws = Worksheets.Add(After:=afterDoc)
    ws.Name = "OLE_Links"
    ws.Range("A1").Value = "Filename"
    ws.Range("B1").Value = "Linked OLE (icon)"
    ws.Range("C1").Value = "Status"
    Set GetOrCreateOLESheet = ws
End Function

Private Sub ClearOLEObjects(ByVal ws As Worksheet)
    Dim i As Long
    On Error Resume Next
    For i = ws.OLEObjects.Count To 1 Step -1
        ws.OLEObjects(i).Delete
    Next i
    On Error GoTo 0
End Sub

' Fallback if OLE is blocked by policy: file hyperlinks in column B (XlLink-style).
Public Sub AddFileHyperlinksFromDocuments()
    Dim doc As Worksheet
    Dim oleWs As Worksheet
    Dim basePath As String
    Dim r As Long
    Dim fn As String
    Dim fullpath As String
    Dim lastRow As Long
    
    Set doc = Worksheets("Documents")
    Set oleWs = GetOrCreateOLESheet(doc)
    basePath = Trim(CStr(doc.Range("Z1").Value))
    If basePath = "" Then
        MsgBox "Set Documents!Z1 first.", vbExclamation
        Exit Sub
    End If
    If Right(basePath, 1) <> "\" Then basePath = basePath & "\"
    
    lastRow = doc.Cells(doc.Rows.Count, 1).End(xlUp).Row
    For r = 2 To lastRow
        fn = Trim(CStr(doc.Cells(r, 1).Value))
        If fn <> "" Then
            fullpath = basePath & fn
            oleWs.Cells(r, 1).Value = fn
            If Dir(fullpath) <> "" Then
                oleWs.Hyperlinks.Add Anchor:=oleWs.Cells(r, 2), Address:=fullpath, TextToDisplay:=fn
                oleWs.Cells(r, 3).Value = "OK (hyperlink)"
            Else
                oleWs.Cells(r, 3).Value = "Skipped (not found)"
            End If
        End If
    Next r
    MsgBox "Hyperlinks added on OLE_Links column B.", vbInformation
End Sub
