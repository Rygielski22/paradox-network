'use strict'

function isVisitEnabled () { return false }
function isVisitGuard () { return false }
function shouldBlockVisitCorrection () { return false }
function bindVisitCapture () {}
function finishVisitOff () {}

module.exports = {
  isVisitEnabled,
  isVisitGuard,
  shouldBlockVisitCorrection,
  bindVisitCapture,
  finishVisitOff
}