// 参数合同与原 openNURBS 求值证据；未知类型显式保留 unsupported。
static void arcParameterMap(std::ostream& o, const ON_ArcCurve& arc) {
  ON_NurbsCurve n;
  if(arc.GetNurbForm(n)<=0) throw std::runtime_error("arc-map-nurbs-failed");
  o << "{\"kind\":\"arc-angle\",\"angleRadians\":"; number(o,arc.AngleRadians());
  o << ",\"domain\":"; interval(o,arc.Domain());
  o << ",\"breaks\":[";
  bool first=true; double previous=ON_UNSET_VALUE;
  for(int i=n.Degree()-1;i<=n.m_cv_count-1;++i) {
    const double knot=n.m_knot[i];
    if(!first && knot==previous) continue;
    if(!first) o << ','; number(o,knot); first=false; previous=knot;
  }
  o << "]}";
}
static void curveParameterMap(std::ostream& o, const ON_Curve& source, int accuracy) {
  if(accuracy==1) o << "{\"kind\":\"identity\"}";
  else if(auto arc=ON_ArcCurve::Cast(&source)) arcParameterMap(o,*arc);
  else o << "{\"kind\":\"unsupported\"}";
}
static void surfaceParameterMap(std::ostream& o, const ON_Surface& source, int accuracy) {
  if(accuracy==1) { o << "{\"kind\":\"identity\"}"; return; }
  const auto rev=ON_RevSurface::Cast(&source);
  if(!rev || !rev->m_curve) { o << "{\"kind\":\"unsupported\"}"; return; }
  ON_ArcCurve angular(ON_Arc(ON_Circle(ON_xy_plane,1.0),rev->m_angle),rev->m_t[0],rev->m_t[1]);
  ON_NurbsCurve profile;
  const int profileAccuracy=rev->m_curve->GetNurbForm(profile);
  o << "{\"kind\":\"separable\",\"axes\":[";
  if(rev->m_bTransposed) curveParameterMap(o,*rev->m_curve,profileAccuracy);
  else arcParameterMap(o,angular);
  o << ',';
  if(rev->m_bTransposed) arcParameterMap(o,angular);
  else curveParameterMap(o,*rev->m_curve,profileAccuracy);
  o << "]}";
}
static void parameterPoint(std::ostream& o, const ON_3dPoint& p) {
  o << '['; number(o,p.x); o << ','; number(o,p.y); o << ','; number(o,p.z); o << ']';
}
static void analyticSurfaceSupport(std::ostream& o, const ON_Surface& source) {
  ON_Sphere sphere;
  ON_Cylinder cylinder;
  if(source.IsSphere(&sphere,1e-10)) {
    o << "{\"kind\":\"sphere\",\"radius\":"; number(o,sphere.radius);
    o << ",\"center\":"; parameterPoint(o,sphere.Center()); o << '}';
  } else if(source.IsCylinder(&cylinder,1e-10)) {
    o << "{\"kind\":\"cylinder\",\"radius\":"; number(o,cylinder.circle.radius);
    o << ",\"center\":"; parameterPoint(o,cylinder.Center());
    o << ",\"axis\":"; parameterPoint(o,ON_3dPoint(cylinder.Axis())); o << '}';
  } else o << "null";
}
static void curveParameterEvidence(std::ostream& o, const ON_Curve& source) {
  o << '[';
  for(int i=0;i<=37;++i) {
    const double t=source.Domain().ParameterAt(i/37.0); double mapped=0;
    if(!source.GetNurbFormParameterFromCurveParameter(t,&mapped)) throw std::runtime_error("curve-parameter-map-failed");
    if(i) o << ','; o << "{\"source\":"; number(o,t);
    o << ",\"mapped\":"; number(o,mapped); o << ",\"point\":"; parameterPoint(o,source.PointAt(t)); o << '}';
  }
  o << ']';
}
static void surfaceParameterEvidence(std::ostream& o, const ON_Surface& source) {
  o << '[';
  for(int v=0;v<=13;++v) for(int u=0;u<=17;++u) {
    const double s=source.Domain(0).ParameterAt(u/17.0), t=source.Domain(1).ParameterAt(v/13.0);
    double ns=0,nt=0;
    if(!source.GetNurbFormParameterFromSurfaceParameter(s,t,&ns,&nt)) throw std::runtime_error("surface-parameter-map-failed");
    if(u||v) o << ','; o << "{\"source\":["; number(o,s); o << ','; number(o,t);
    o << "],\"mapped\":["; number(o,ns); o << ','; number(o,nt);
    o << "],\"point\":"; parameterPoint(o,source.PointAt(s,t)); o << '}';
  }
  o << ']';
}
